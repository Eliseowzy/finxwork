//! The models clients see: providers with where their keys and models come from, each model's
//! details and whether it is in the model menu (docs/kernel/model-catalog-design.md §6, §8).
//! Shared by `finx models` and the protocol service.

use finx_llm::AuthConfig;
use finx_llm::AuthStatus;
use finx_llm::Model;
use finx_llm::ModelRegistry;
use finx_llm::ProviderConfig;
use finx_llm::directory::IdSource;
use finx_llm::directory::ModelMeta;
use finx_llm::discovery::ListSource;
use finx_llm::discovery::ModelList;
use finx_protocol::api::AuthKind;
use finx_protocol::api::CredentialState;
use finx_protocol::api::ListingError;
use finx_protocol::api::ListingSource;
use finx_protocol::api::ModelPrice;
use finx_protocol::api::ModelSummary;
use finx_protocol::api::ModelsListResult;
use finx_protocol::api::ProviderListing;
use finx_protocol::api::ProviderSummary;
use finx_protocol::api::SessionDefaults;
use finx_llm::ThinkingLevel;

/// The public catalog's address; tests point it at a local server.
pub fn catalog_url() -> String {
    std::env::var("FINX_MODEL_CATALOG_URL").unwrap_or_else(|_| finx_llm::public_catalog::SOURCE_URL.to_string())
}

/// Providers whose list can be asked now: they have one, own it, and have credentials.
pub fn refreshable(llm: &ModelRegistry) -> Vec<String> {
    llm.providers()
        .filter(|p| {
            p.listing.path.is_some()
                && p.listing.from.is_none()
                && !matches!(p.auth.status(&p.id), AuthStatus::Missing(_) | AuthStatus::Managed)
        })
        .map(|p| p.id)
        .collect()
}

fn credential_of(status: &AuthStatus) -> (CredentialState, Option<String>) {
    match status {
        AuthStatus::NotRequired => (CredentialState::NotRequired, None),
        AuthStatus::Managed => (CredentialState::Connection, None),
        AuthStatus::Configured(source) if source == "config" => (CredentialState::Config, None),
        AuthStatus::Configured(source) => (CredentialState::Env, Some(source.clone())),
        AuthStatus::Stored => (CredentialState::Stored, None),
        AuthStatus::Missing(_) => (CredentialState::Missing, None),
        AuthStatus::Command => (CredentialState::Command, None),
    }
}

/// A local server that did not answer cannot be used.
fn unreachable(provider: &ProviderConfig, list: Option<&ModelList>) -> bool {
    matches!(provider.auth, AuthConfig::None)
        && list.and_then(|l| l.error.as_ref()).is_some_and(|e| e.kind == "network" || e.kind == "timeout")
}

/// The level a session starts with on `model` (§18): the one last chosen on it, else its
/// configured default, else `Default`.
pub fn start_thinking(llm: &ModelRegistry, model: &Model) -> ThinkingLevel {
    llm.directory()
        .remembered_thinking(&model.reference())
        .filter(|l| model.offers(*l))
        .unwrap_or(model.default_thinking)
}

/// The level a session keeps when it moves to `model` holding `current` (§18): `current` when the
/// model offers it, else the level the model starts with.
pub fn thinking_for(llm: &ModelRegistry, model: &Model, current: ThinkingLevel) -> ThinkingLevel {
    if current != ThinkingLevel::Default && model.offers(current) {
        current
    } else {
        start_thinking(llm, model)
    }
}

fn summary_of(llm: &ModelRegistry, model: &Model, meta: &ModelMeta, available: bool, shown: bool) -> ModelSummary {
    ModelSummary {
        id: model.reference(),
        name: model.name.clone(),
        provider: model.provider.clone(),
        context_window: u64::from(model.context_window),
        reasoning: model.reasoning,
        thinking_levels: model.thinking.clone(),
        default_thinking: start_thinking(llm, model),
        images: model.accepts_images(),
        available,
        shown,
        known: meta.known,
        deprecated: meta.deprecated,
        released: meta.released.clone(),
        cost: model.cost.is_configured().then(|| ModelPrice {
            input: model.cost.input,
            output: model.cost.output,
            cache_read: (model.cost.cache_read > 0.0).then_some(model.cost.cache_read),
            cache_write: (model.cost.cache_write > 0.0).then_some(model.cost.cache_write),
            currency: model.currency,
        }),
    }
}


/// Models, providers with where their keys and models come from, and the defaults of new
/// sessions. `refreshing` says which providers' lists are being refreshed. May read saved keys
/// (the keychain), so it blocks.
pub fn list(llm: &ModelRegistry, defaults: &SessionDefaults, refreshing: &dyn Fn(&str) -> bool) -> ModelsListResult {
    let directory = llm.directory();
    let selection = directory.selection();
    let default_model = &defaults.model;
    let mut providers = Vec::new();
    let mut models = Vec::new();
    for provider in llm.providers() {
        let (credential, credential_source) = credential_of(&provider.auth.status(&provider.id));
        let mut summary = ProviderSummary {
            id: provider.id.clone(),
            name: provider.name.clone(),
            auth: match provider.auth {
                AuthConfig::None => AuthKind::None,
                AuthConfig::Managed => AuthKind::Connection,
                AuthConfig::ApiKey { .. } => AuthKind::ApiKey,
                AuthConfig::Command { .. } => AuthKind::Command,
            },
            credential,
            credential_source,
            key_env: provider.auth.env_vars().to_vec(),
            listing: None,
        };
        if credential == CredentialState::Missing {
            providers.push(summary);
            continue;
        }
        if matches!(provider.auth, AuthConfig::Managed) {
            let meta = ModelMeta { known: true, configured: true, chat: true, ..Default::default() };
            // An account connection's models are all shown unless the user hid some.
            models.extend(provider.models.iter().map(|m| summary_of(llm, m, &meta, true, selection.is_shown(&m.reference(), true))));
            providers.push(summary);
            continue;
        }
        let merged = directory.models(&provider);
        let list = merged.list.as_ref();
        if !unreachable(&provider, list) {
            let shown_by_default = merged.default_shown(provider.listing.from.is_some());
            let (mut count, mut shown) = (0, 0);
            for m in merged.models.iter().filter(|m| m.meta.chat) {
                let reference = m.model.reference();
                let by_default = shown_by_default.contains(&m.model.id) || reference == *default_model;
                let is_shown = selection.is_shown(&reference, by_default);
                count += 1;
                shown += u32::from(is_shown);
                models.push(summary_of(llm, &m.model, &m.meta, true, is_shown));
            }
            summary.listing = provider.listing.is_dynamic().then(|| ProviderListing {
                source: match merged.source {
                    IdSource::Provider => ListingSource::Provider,
                    IdSource::Catalog => ListingSource::Catalog,
                    IdSource::Config if list.is_some_and(|l| l.source == ListSource::Unsupported) => {
                        ListingSource::Unsupported
                    }
                    IdSource::Config => ListingSource::Config,
                },
                fetched_at: list.and_then(|l| l.fetched_at.clone()),
                refreshing: refreshing(&provider.id),
                error: list
                    .and_then(|l| l.error.as_ref())
                    .map(|e| ListingError { kind: e.kind.clone(), message: e.message.clone() }),
                models: count,
                shown,
            });
        } else {
            summary.listing = Some(ProviderListing {
                source: ListingSource::Provider,
                fetched_at: list.and_then(|l| l.fetched_at.clone()),
                refreshing: false,
                error: list
                    .and_then(|l| l.error.as_ref())
                    .map(|e| ListingError { kind: e.kind.clone(), message: e.message.clone() }),
                models: 0,
                shown: 0,
            });
        }
        providers.push(summary);
    }
    // The default model shows even without its key, so a new session can ask for it.
    if !models.iter().any(|m| m.id == *default_model)
        && let Ok(resolved) = llm.resolve(default_model)
    {
        let meta = ModelMeta { known: !resolved.ad_hoc, ..Default::default() };
        models.push(summary_of(llm, &resolved.model, &meta, false, true));
    }
    ModelsListResult { models, providers, defaults: Some(defaults.clone()) }
}

/// Puts a model in the menu or takes it out (`models/show`). Blocking I/O.
pub fn set_shown(llm: &ModelRegistry, default_model: &str, reference: &str, shown: bool) -> Result<(), String> {
    let (provider_id, model_id) = reference
        .split_once('/')
        .ok_or_else(|| format!("expected provider/model-id, got '{reference}'"))?;
    let provider =
        llm.provider(provider_id).ok_or_else(|| format!("unknown provider '{provider_id}'"))?;
    let by_default = reference == default_model
        || matches!(provider.auth, AuthConfig::Managed)
        || llm.directory().models(&provider).default_shown(provider.listing.from.is_some()).contains(model_id);
    llm.directory().set_shown(reference, shown, by_default).map_err(|e| e.message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use finx_llm::Catalog;
    use finx_llm::RegistryOptions;
    use finx_protocol::PermissionMode;
    use finx_llm::ThinkingLevel;

    #[test]
    fn an_account_connections_models_can_be_hidden() {
        let dir = tempfile::tempdir().unwrap();
        let llm = ModelRegistry::new(
            Catalog::default(),
            RegistryOptions { models_dir: Some(dir.path().to_path_buf()), ..Default::default() },
        );
        let mut provider = Catalog::from_toml("[providers.x]\napi = \"openai-chat\"\nbase_url = \"https://x.invalid/v1\"\n")
            .unwrap()
            .providers
            .remove("x")
            .unwrap();
        provider.id = "qwenwork-a".into();
        provider.auth = AuthConfig::Managed;
        provider.models = ["flash", "pro"].map(|id| std::sync::Arc::new(provider.ad_hoc_model(id))).to_vec();
        llm.replace_source("model-connections", vec![provider]).unwrap();
        let defaults = SessionDefaults { model: "deepseek/deepseek-flash".into(), thinking: ThinkingLevel::Medium, permission_mode: PermissionMode::Manual };
        let shown = |llm: &ModelRegistry| -> Vec<(String, bool)> {
            list(llm, &defaults, &|_| false).models.into_iter().filter(|m| m.provider == "qwenwork-a").map(|m| (m.id, m.shown)).collect()
        };
        assert_eq!(shown(&llm), [("qwenwork-a/flash".to_string(), true), ("qwenwork-a/pro".to_string(), true)]);
        set_shown(&llm, &defaults.model, "qwenwork-a/pro", false).unwrap();
        assert_eq!(shown(&llm), [("qwenwork-a/flash".to_string(), true), ("qwenwork-a/pro".to_string(), false)]);
        set_shown(&llm, &defaults.model, "qwenwork-a/pro", true).unwrap();
        assert!(llm.directory().selection().hide.is_empty(), "showing it again forgets the choice");
    }
}
