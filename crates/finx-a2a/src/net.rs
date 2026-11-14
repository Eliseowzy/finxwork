//! The HTTP client an external bot is reached through (docs/kernel/bot-contacts-design.md §5.2,
//! §8): finx's TLS setup, no proxy for a service on this machine, and a resolver that only lets
//! through addresses the request may go to.

use std::net::IpAddr;
use std::net::Ipv4Addr;
use std::net::SocketAddr;
use std::sync::Arc;

use bytes::Bytes;
use futures::StreamExt;
use reqwest::Url;
use reqwest::dns::Addrs;
use reqwest::dns::Name;
use reqwest::dns::Resolve;
use reqwest::dns::Resolving;

type BoxError = Box<dyn std::error::Error + Send + Sync>;

/// A client for one address. `no_proxy` is for a service on this machine: the system proxy would
/// take a loopback request off the machine or refuse it.
pub(crate) fn client(allow_local: bool, no_proxy: bool) -> Result<reqwest::Client, String> {
    let tls = finx_llm::tls_client_config().map_err(|e| format!("cannot set up TLS: {e}"))?;
    let mut builder = reqwest::Client::builder()
        .use_preconfigured_tls(tls)
        .redirect(redirect_policy(allow_local))
        .dns_resolver(Arc::new(GuardedResolver { allow_local }))
        .connect_timeout(std::time::Duration::from_secs(10))
        .user_agent(format!("finx/{}", env!("CARGO_PKG_VERSION")));
    if no_proxy {
        builder = builder.no_proxy();
    }
    builder
        .build()
        .map_err(|e| format!("cannot set up HTTP: {e}"))
}

/// Whether a URL may be requested at all. The resolver cannot see an IP-literal host, and a host
/// name is only known to resolve locally after connecting, so the caller checks the URL's host
/// with the same rules first; the resolver then checks the addresses it actually got.
pub(crate) fn check_url(url: &Url, allow_local: bool) -> Result<(), String> {
    let host = url.host_str().ok_or("the address has no host")?;
    let https = url.scheme() == "https";
    let loopback = is_loopback_host(host);
    if !https && !(url.scheme() == "http" && allow_local && loopback) {
        return Err("only an HTTPS address is allowed".into());
    }
    if is_local_host(host) && !(allow_local && loopback) {
        return Err(format!("{host} is a private address"));
    }
    Ok(())
}

/// Whether a host is this machine or a private network, by its name or address alone.
pub(crate) fn is_local_host(host: &str) -> bool {
    is_private_host(host)
}

/// The names and addresses `allow_local` lets through: only loopback, not a whole intranet
/// (§5.8: other private addresses stay refused).
pub(crate) fn is_loopback_host(host: &str) -> bool {
    let host = host.trim_start_matches('[').trim_end_matches(']');
    host == "localhost"
        || host.ends_with(".localhost")
        || host
            .parse::<IpAddr>()
            .is_ok_and(|ip| canonical(ip).is_loopback())
}

fn is_private_host(host: &str) -> bool {
    let host = host.trim_start_matches('[').trim_end_matches(']');
    host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.parse::<IpAddr>().is_ok_and(is_private_ip)
}

fn is_private_ip(ip: IpAddr) -> bool {
    match canonical(ip) {
        IpAddr::V4(v4) => is_private_v4(v4),
        IpAddr::V6(v6) => is_private_v6(v6),
    }
}

/// Every IPv4 address that is not somewhere on the public internet (§5.2, §8): this machine,
/// a private network, the carrier-grade NAT range (100.64/10, which Tailscale also uses),
/// multicast, broadcast, and the reserved space.
fn is_private_v4(v4: Ipv4Addr) -> bool {
    let o = v4.octets();
    v4.is_loopback()
        || v4.is_private()
        || v4.is_link_local()
        || v4.is_unspecified()
        || v4.is_multicast()
        || v4.is_broadcast()
        || o[0] == 0
        || o[0] >= 240
        || (o[0] == 100 && (64..=127).contains(&o[1]))
}

/// The IPv6 ranges that are not public, including the ones that carry an IPv4 address inside
/// (NAT64 and 6to4): what they embed decides, so `64:ff9b::a00:1` is 10.0.0.1.
fn is_private_v6(v6: std::net::Ipv6Addr) -> bool {
    let s = v6.segments();
    if v6.is_loopback()
        || v6.is_unspecified()
        || v6.is_multicast()
        || (s[0] & 0xffc0) == 0xfe80
        || (s[0] & 0xfe00) == 0xfc00
    {
        return true;
    }
    // 64:ff9b::/96: NAT64, the IPv4 address in the last 32 bits.
    if s[0] == 0x0064 && s[1] == 0xff9b && s[2..6] == [0, 0, 0, 0] {
        return is_private_v4(embedded_v4(s[6], s[7]));
    }
    // 2002::/16: 6to4, the IPv4 address in the next 32 bits.
    if s[0] == 0x2002 {
        return is_private_v4(embedded_v4(s[1], s[2]));
    }
    false
}

fn embedded_v4(high: u16, low: u16) -> Ipv4Addr {
    Ipv4Addr::new((high >> 8) as u8, high as u8, (low >> 8) as u8, low as u8)
}

/// An IPv4 address written as IPv6 (`::ffff:127.0.0.1`) is still that address.
fn canonical(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(ip),
        IpAddr::V4(_) => ip,
    }
}

/// Resolves with `lookup_host`, drops every address the request may not go to, and returns the
/// ones it may. Returning exactly the addresses that passed — rather than checking and letting
/// reqwest resolve again — pins the IP that is actually connected to, so a name cannot be public
/// during the check and private at connect time (a DNS rebind).
struct GuardedResolver {
    allow_local: bool,
}

impl Resolve for GuardedResolver {
    fn resolve(&self, name: Name) -> Resolving {
        resolve(name.as_str().to_string(), self.allow_local)
    }
}

fn resolve(host: String, allow_local: bool) -> Resolving {
    Box::pin(async move {
        let addrs = tokio::net::lookup_host((host.as_str(), 0))
            .await
            .map_err(|e| -> BoxError { format!("cannot resolve {host}: {e}").into() })?;
        let kept: Vec<SocketAddr> = addrs
            .filter(|addr| {
                let ip = canonical(addr.ip());
                !is_private_ip(ip) || (allow_local && ip.is_loopback())
            })
            .collect();
        if kept.is_empty() {
            return Err(format!("{host} is a private address").into());
        }
        Ok(Box::new(kept.into_iter()) as Addrs)
    })
}

/// Redirects stay on the same scheme, host and port, and only an HTTPS one is followed (an
/// HTTP one only to loopback with `allow_local`). More than five hops is a loop.
fn redirect_policy(allow_local: bool) -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(move |attempt| {
        let Some(previous) = attempt.previous().last() else {
            return attempt.stop();
        };
        let target = attempt.url();
        let same_origin = target.scheme() == previous.scheme()
            && target.host_str() == previous.host_str()
            && target.port_or_known_default() == previous.port_or_known_default();
        let https = target.scheme() == "https";
        let loopback_http = allow_local
            && target.scheme() == "http"
            && target.host_str().is_some_and(is_loopback_host);
        if attempt.previous().len() >= 5 || !same_origin || !(https || loopback_http) {
            attempt.stop()
        } else {
            attempt.follow()
        }
    })
}

/// A response body that went past what this side keeps. The stream ends with it: the other side
/// gets no chance to keep pushing (bot-contacts-design §5.3).
#[derive(Debug, thiserror::Error)]
pub(crate) enum BodyError {
    #[error("the other side sent more than {0} bytes")]
    TooLarge(u64),
    #[error("the connection to the other side broke: {0}")]
    Transport(String),
}

/// The response body, counted as it arrives. Past `cap` the stream yields one error and stops,
/// so a peer cannot exhaust memory by never finishing a sentence or a file.
pub(crate) fn body(
    response: reqwest::Response,
    cap: u64,
) -> impl futures::Stream<Item = Result<Bytes, BodyError>> + Send {
    let stream = response.bytes_stream().boxed();
    // `Some` holds the body while it may still be read; an error ends the stream for good, so
    // that a caller that polls again after it cannot keep the other side sending.
    futures::stream::unfold((Some(stream), 0u64), move |(stream, total)| async move {
        let mut stream = stream?;
        match stream.next().await {
            Some(Ok(chunk)) => {
                let total = total + chunk.len() as u64;
                if total > cap {
                    return Some((Err(BodyError::TooLarge(cap)), (None, total)));
                }
                Some((Ok(chunk), (Some(stream), total)))
            }
            Some(Err(error)) => Some((
                Err(BodyError::Transport(error.to_string())),
                (None, total),
            )),
            None => None,
        }
    })
}

/// A whole body, read with the same limit (an answer that is not streamed, or an error's words).
pub(crate) async fn read_body(response: reqwest::Response, cap: u64) -> Result<Vec<u8>, BodyError> {
    let mut stream = Box::pin(body(response, cap));
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        bytes.extend_from_slice(&chunk?);
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(value: &str) -> Url {
        Url::parse(value).expect("test URL")
    }

    #[test]
    fn local_names_and_addresses_are_recognized() {
        for host in [
            "localhost",
            "127.0.0.1",
            "10.1.2.3",
            "172.20.0.5",
            "192.168.0.9",
            "[::1]",
            "box.local",
            "0.0.0.0",
        ] {
            assert!(is_local_host(host), "{host}");
        }
        for host in ["api.openai.com", "8.8.8.8", "172.32.0.1"] {
            assert!(!is_local_host(host), "{host}");
        }
    }

    #[test]
    fn only_https_is_allowed_away_from_loopback() {
        assert!(check_url(&url("https://example.com/a2a"), false).is_ok());
        assert!(check_url(&url("http://example.com/a2a"), false).is_err());
        assert!(check_url(&url("http://127.0.0.1:9999/"), false).is_err());
        assert!(check_url(&url("http://127.0.0.1:9999/"), true).is_ok());
        assert!(check_url(&url("http://192.168.1.4:9999/"), true).is_err());
        assert!(check_url(&url("https://192.168.1.4/"), false).is_err());
        assert!(check_url(&url("http://localhost:9999/"), false).is_err());
    }

    #[test]
    fn private_addresses_are_refused() {
        for ip in [
            // This machine and the private networks.
            "127.0.0.1",
            "10.0.0.1",
            "192.168.1.1",
            "169.254.1.1",
            "::1",
            "fd00::1",
            "fe80::1",
            "::ffff:127.0.0.1",
            // Reserved, carrier-grade NAT (Tailscale too), multicast, broadcast.
            "0.0.0.0",
            "0.1.2.3",
            "100.64.0.1",
            "100.127.255.254",
            "224.0.0.1",
            "239.255.255.250",
            "255.255.255.255",
            "240.0.0.1",
            "ff02::1",
            // IPv6 ranges that carry an IPv4 address inside.
            "64:ff9b::a00:1",
            "2002:0a00:0001::1",
        ] {
            let ip: IpAddr = ip.parse().expect("test address");
            assert!(is_private_ip(ip), "{ip}");
        }
        for ip in [
            "8.8.8.8",
            "1.1.1.1",
            "100.63.255.254",
            "100.128.0.1",
            "2606:4700:4700::1111",
            // Public addresses, even though they sit near the private ones.
            "172.32.0.1",
            "192.169.0.1",
        ] {
            let ip: IpAddr = ip.parse().expect("test address");
            assert!(!is_private_ip(ip), "{ip}");
        }
    }

    #[tokio::test]
    async fn a_body_past_its_limit_ends_the_stream() {
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_bytes(vec![b'x'; 4096]))
            .mount(&server)
            .await;
        let http = client(true, true).expect("an HTTP client");
        let response = http.get(server.uri()).send().await.expect("the body");
        let error = read_body(response, 1024).await.expect_err("too large");
        assert!(matches!(error, BodyError::TooLarge(1024)), "{error}");
        // Under the limit, the same body reads whole.
        let response = http.get(server.uri()).send().await.expect("the body");
        assert_eq!(read_body(response, 8192).await.expect("under the limit").len(), 4096);

        // Past the limit, the stream ends right after the error: the loop ends there, and the
        // body is no longer read.
        let response = http.get(server.uri()).send().await.expect("the body");
        let mut stream = Box::pin(body(response, 1024));
        let mut errors = 0;
        let mut chunks = 0;
        while let Some(item) = stream.next().await {
            if item.is_err() {
                errors += 1;
            } else {
                chunks += 1;
            }
        }
        assert_eq!((chunks, errors), (0, 1), "the first chunk is past the limit, then the end");
    }
}
