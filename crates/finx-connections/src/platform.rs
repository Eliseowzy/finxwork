//! Platform reads and private credential storage. No source application file is written.
use crate::{ConnectionError, Result};
use async_trait::async_trait;
use cbc::cipher::{BlockDecryptMut, KeyIvInit, block_padding::Pkcs7};
use finx_protocol::api::ConnectionDiscovery;
use serde_json::Value;
use std::{
    collections::BTreeMap,
    num::NonZeroU32,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::{io::AsyncWriteExt, process::Command};
use zeroize::Zeroizing;

pub struct Login {
    pub subject: Option<String>,
    pub token: String,
    pub expires: i64,
    pub identity: String,
}
#[async_trait]
pub trait Environment: Send + Sync {
    async fn discover(&self) -> Result<ConnectionDiscovery>;
    async fn login(&self) -> Result<Login>;
    /// Only explicit settings actions may request an OS authorization prompt.
    async fn interactive_login(&self) -> Result<Login> {
        self.login().await
    }

    async fn headers(&self) -> Result<BTreeMap<String, String>>;
    async fn get(&self, id: &str) -> Result<Option<String>>;
    async fn set(&self, id: &str, value: &str) -> Result<()>;
    async fn delete(&self, id: &str) -> Result<()>;
    fn now(&self) -> i64 {
        chrono::Utc::now().timestamp_millis()
    }
}

pub struct System {
    namespace: String,
    product: &'static str,
}
pub fn system(home: &Path) -> Arc<dyn Environment> {
    system_for(home, "qwenwork")
}
pub fn system_for(home: &Path, product: &'static str) -> Arc<dyn Environment> {
    Arc::new(System {
        product,
        namespace: format!(
            "finx-model-connections-{}",
            &digest(home.to_string_lossy().as_bytes())[..16]
        ),
    })
}
pub(crate) fn digest(value: &[u8]) -> String {
    ring::digest::digest(&ring::digest::SHA256, value)
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
impl System {
    fn app_path(&self) -> &'static str {
        if self.product == "qoder" {
            "/Applications/Qoder.app/Contents/Info.plist"
        } else {
            "/Applications/QwenWorkCN.app/Contents/Info.plist"
        }
    }
    fn auth_path(&self) -> Result<PathBuf> {
        if self.product == "qoder" {
            Ok(dirs::home_dir()
                .ok_or_else(ConnectionError::unsupported)?
                .join("Library/Application Support/com.qoder.app.stable/auth.v1.dat"))
        } else {
            auth_path()
        }
    }
    fn service(&self) -> &'static str {
        if self.product == "qoder" {
            "Qoder App Safe Storage"
        } else {
            "QwenWorkCN Safe Storage"
        }
    }
    async fn read_login(&self, interactive: bool) -> Result<Login> {
        supported()?;
        if !tokio::fs::try_exists(self.app_path())
            .await
            .unwrap_or(false)
        {
            return Err(ConnectionError::new("unsupported", "来源应用不可用"));
        }
        let file = self.auth_path()?;
        if tokio::fs::metadata(&file)
            .await
            .map_err(|_| ConnectionError::login())?
            .len()
            > 1024 * 1024
        {
            return Err(ConnectionError::unsupported());
        }
        let sealed = tokio::fs::read(file)
            .await
            .map_err(|_| ConnectionError::login())?;
        let service = self.service();
        let password = tokio::task::spawn_blocking(move || source_password(service, interactive))
            .await
            .map_err(|_| ConnectionError::unavailable())??;
        let value = decrypt_value(&sealed, &password)?;
        if self.product == "qoder" {
            crate::qoder::source_login(&value)
        } else {
            parse_qwen_login(&value)
        }
    }
}
fn auth_path() -> Result<PathBuf> {
    Ok(dirs::home_dir()
        .ok_or_else(|| ConnectionError::new("unsupported", "无法定位用户目录"))?
        .join("Library/Application Support/QwenWorkCN/auth-v2.dat"))
}
fn supported() -> Result<()> {
    if cfg!(target_os = "macos") {
        Ok(())
    } else {
        Err(ConnectionError::new(
            "unsupported",
            "本机应用连接目前只支持 macOS",
        ))
    }
}
async fn command(
    program: &str,
    args: &[&str],
    input: Option<&str>,
) -> Result<std::process::Output> {
    let mut child = Command::new(program)
        .args(args)
        .kill_on_drop(true)
        .stdin(if input.is_some() {
            std::process::Stdio::piped()
        } else {
            std::process::Stdio::null()
        })
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|_| {
            ConnectionError::new("connection_permission_required", "无法读取本机应用或钥匙串")
        })?;
    if let Some(value) = input {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(ConnectionError::unavailable)?;
        stdin
            .write_all(value.as_bytes())
            .await
            .map_err(|_| ConnectionError::unavailable())?;
    }
    tokio::time::timeout(Duration::from_secs(30), child.wait_with_output())
        .await
        .map_err(|_| {
            ConnectionError::new(
                "connection_permission_required",
                "钥匙串操作超时，请检查系统授权提示",
            )
        })?
        .map_err(|_| ConnectionError::unavailable())
}
#[async_trait]
impl Environment for System {
    async fn discover(&self) -> Result<ConnectionDiscovery> {
        let installed = cfg!(target_os = "macos")
            && tokio::fs::try_exists(self.app_path())
                .await
                .unwrap_or(false);
        let version = if installed {
            let out = command(
                "/usr/bin/plutil",
                &[
                    "-extract",
                    "CFBundleShortVersionString",
                    "raw",
                    self.app_path(),
                ],
                None,
            )
            .await?;
            if out.status.success() {
                Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
            } else {
                None
            }
        } else {
            None
        };
        Ok(ConnectionDiscovery {
            adapter_id: self.product.into(),
            installed,
            version,
            discovery_id: format!("{}-standard", self.product),
            login: if installed
                && tokio::fs::try_exists(self.auth_path()?)
                    .await
                    .unwrap_or(false)
            {
                "unknown"
            } else {
                "missing"
            }
            .into(),
        })
    }
    async fn login(&self) -> Result<Login> {
        self.read_login(false).await
    }
    async fn interactive_login(&self) -> Result<Login> {
        self.read_login(true).await
    }
    async fn headers(&self) -> Result<BTreeMap<String, String>> {
        supported()?;
        if self.product == "qoder" {
            let discovery = self.discover().await?;
            if !discovery.installed || discovery.version.as_deref() != Some("0.4.11") {
                return Err(ConnectionError::new(
                    "unsupported",
                    "该 Qoder 版本尚未通过兼容性验证",
                ));
            }
            return Ok(BTreeMap::new());
        }
        let out = command(
            "/usr/bin/plutil",
            &["-convert", "json", "-o", "-", self.app_path()],
            None,
        )
        .await?;
        if !out.status.success() {
            return Err(ConnectionError::unsupported());
        }
        let p: Value =
            serde_json::from_slice(&out.stdout).map_err(|_| ConnectionError::unsupported())?;
        let version = p["CFBundleShortVersionString"]
            .as_str()
            .ok_or_else(ConnectionError::unsupported)?;
        if version != "1.4.0" {
            return Err(ConnectionError::new(
                "unsupported",
                "该千问版本尚未通过兼容性验证",
            ));
        }
        let build = p["CFBundleVersion"]
            .as_str()
            .ok_or_else(ConnectionError::unsupported)?;
        Ok(BTreeMap::from([
            ("X-QwenWork-Version".into(), version.into()),
            (
                "X-QwenWork-Release-Version".into(),
                format!("{version}-{build}"),
            ),
            ("X-QwenWork-Build".into(), build.into()),
            ("X-QwenWork-Platform".into(), "darwin".into()),
            (
                "X-QwenWork-Arch".into(),
                if cfg!(target_arch = "aarch64") {
                    "arm64"
                } else {
                    "x64"
                }
                .into(),
            ),
            ("X-QwenWork-Channel".into(), "stable".into()),
        ]))
    }
    async fn get(&self, id: &str) -> Result<Option<String>> {
        supported()?;
        let out = command(
            "/usr/bin/security",
            &[
                "find-generic-password",
                "-s",
                &self.namespace,
                "-a",
                id,
                "-w",
            ],
            None,
        )
        .await?;
        match out.status.code() {
            Some(0) => Ok(Some(
                String::from_utf8_lossy(&out.stdout).trim().to_string(),
            )),
            Some(44) => Ok(None),
            _ => Err(ConnectionError::new(
                "connection_permission_required",
                "无法读取连接服务钥匙串",
            )),
        }
    }
    async fn set(&self, id: &str, value: &str) -> Result<()> {
        supported()?;
        if id.contains(['\n', '\r', '\0']) || value.contains(['\n', '\r', '\0']) {
            return Err(ConnectionError::unsupported());
        }
        let quote = |v: &str| format!("\"{}\"", v.replace('\\', "\\\\").replace('"', "\\\""));
        let input = Zeroizing::new(format!(
            "add-generic-password -U -s {} -a {} -w {}\n",
            quote(&self.namespace),
            quote(id),
            quote(value)
        ));
        let out = command("/usr/bin/security", &["-i"], Some(&input)).await?;
        let diagnostic = String::from_utf8_lossy(&out.stderr).to_lowercase();
        if !out.status.success()
            || ["seckeychain", "error:", "denied", "failed"]
                .iter()
                .any(|v| diagnostic.contains(v))
        {
            return Err(ConnectionError::new(
                "connection_permission_required",
                "无法保存连接服务钥匙串",
            ));
        }
        Ok(())
    }
    async fn delete(&self, id: &str) -> Result<()> {
        supported()?;
        let out = command(
            "/usr/bin/security",
            &["delete-generic-password", "-s", &self.namespace, "-a", id],
            None,
        )
        .await?;
        if matches!(out.status.code(), Some(0 | 44)) {
            Ok(())
        } else {
            Err(ConnectionError::new(
                "connection_permission_required",
                "无法删除连接服务钥匙串",
            ))
        }
    }
}

#[cfg(test)]
pub(crate) fn decrypt_login(sealed: &[u8], password: &[u8]) -> Result<Login> {
    parse_qwen_login(&decrypt_value(sealed, password)?)
}
fn decrypt_value(sealed: &[u8], password: &[u8]) -> Result<Value> {
    if !sealed.starts_with(b"v10") {
        return Err(ConnectionError::unsupported());
    }
    let mut key = Zeroizing::new([0u8; 16]);
    ring::pbkdf2::derive(
        ring::pbkdf2::PBKDF2_HMAC_SHA1,
        NonZeroU32::new(1003).unwrap(),
        b"saltysalt",
        password,
        key.as_mut(),
    );
    let plain = Zeroizing::new(
        cbc::Decryptor::<aes::Aes128>::new_from_slices(key.as_ref(), &[32; 16])
            .map_err(|_| ConnectionError::unsupported())?
            .decrypt_padded_vec_mut::<Pkcs7>(&sealed[3..])
            .map_err(|_| ConnectionError::unsupported())?,
    );
    serde_json::from_slice(&plain).map_err(|_| ConnectionError::unsupported())
}
fn parse_qwen_login(value: &Value) -> Result<Login> {
    if value["schemaVersion"] != 2
        || value["authRealm"] == "premiumIam"
        || value["endpoints"]["apiOrigin"]
            .as_str()
            .is_some_and(|s| !s.is_empty())
        || value["openApiBase"].as_str().is_some_and(|s| !s.is_empty())
    {
        return Err(ConnectionError::unsupported());
    }
    let token = value["token"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(ConnectionError::login)?
        .to_string();
    let user = &value["user"];
    let stable = ["id", "userId", "uid", "sub", "email"]
        .iter()
        .find_map(|k| user.get(*k).filter(|v| !v.is_null()))
        .ok_or_else(ConnectionError::unsupported)?;
    let tenant = user
        .get("tenantId")
        .or_else(|| user.get("orgId"))
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or(Value::String(String::new()));
    let realm = value
        .get("authRealm")
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or(Value::String("standard".into()));
    let identity = digest(
        serde_json::to_string(&serde_json::json!([stable, tenant, realm]))
            .map_err(|_| ConnectionError::unsupported())?
            .as_bytes(),
    );
    let expires = chrono::DateTime::parse_from_rfc3339(
        value["expiresAt"]
            .as_str()
            .ok_or_else(ConnectionError::login)?,
    )
    .map_err(|_| ConnectionError::login())?
    .timestamp_millis();
    Ok(Login {
        subject: None,
        token,
        identity,
        expires,
    })
}

#[cfg(target_os = "macos")]
fn source_password(service: &str, interactive: bool) -> Result<Zeroizing<Vec<u8>>> {
    use core_foundation::{
        base::{CFType, TCFType},
        boolean::CFBoolean,
        data::CFData,
        dictionary::CFDictionary,
        string::CFString,
    };
    use security_framework_sys::{item::*, keychain_item::SecItemCopyMatching};
    unsafe extern "C" {
        static kSecUseAuthenticationUIFail: core_foundation::string::CFStringRef;
    }
    unsafe {
        let string = |v| CFString::wrap_under_get_rule(v).as_CFType();
        let mut pairs = vec![
            (string(kSecClass), string(kSecClassGenericPassword)),
            (string(kSecAttrService), CFString::new(service).as_CFType()),
            (string(kSecReturnData), CFBoolean::true_value().as_CFType()),
        ];
        if !interactive {
            pairs.push((
                string(kSecUseAuthenticationUI),
                string(kSecUseAuthenticationUIFail),
            ));
        }
        let query = CFDictionary::from_CFType_pairs(&pairs);
        let mut result = std::ptr::null();
        let status = SecItemCopyMatching(query.as_concrete_TypeRef(), &mut result);
        if status != 0 || result.is_null() {
            return Err(ConnectionError::new(
                "connection_permission_required",
                "需要允许读取来源应用钥匙串，请在模型设置中重新连接",
            ));
        }
        let result = CFType::wrap_under_create_rule(result);
        let data = result
            .downcast::<CFData>()
            .ok_or_else(ConnectionError::unsupported)?;
        Ok(Zeroizing::new(data.bytes().to_vec()))
    }
}
#[cfg(not(target_os = "macos"))]
fn source_password(_: &str, _: bool) -> Result<Zeroizing<Vec<u8>>> {
    Err(ConnectionError::unsupported())
}
