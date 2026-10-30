//! TLS for model requests: the operating system verifies server certificates, so system and
//! corporate roots are trusted. The verifier is built for the first handshake rather than at
//! start-up: on Linux building it reads and parses the whole system trust store.

use rustls::DigitallySignedStruct;
use rustls::SignatureScheme;
use rustls::client::danger::HandshakeSignatureValid;
use rustls::client::danger::ServerCertVerified;
use rustls::client::danger::ServerCertVerifier;
use rustls::crypto::CryptoProvider;
use rustls::crypto::verify_tls12_signature;
use rustls::crypto::verify_tls13_signature;
use rustls::pki_types::CertificateDer;
use rustls::pki_types::ServerName;
use rustls::pki_types::UnixTime;
use std::sync::Arc;
use std::sync::OnceLock;

pub(crate) fn client_config() -> Result<rustls::ClientConfig, rustls::Error> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let verifier = Arc::new(LazyVerifier {
        provider: provider.clone(),
        platform: OnceLock::new(),
    });
    // This runs when the first request starts. Outside Apple platforms, load the trust store
    // while DNS and the TCP handshake are in flight instead of inside the TLS handshake.
    if cfg!(not(target_vendor = "apple")) {
        let verifier = verifier.clone();
        std::thread::spawn(move || {
            let _ = verifier.platform();
        });
    }
    let mut config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()?
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_no_client_auth();
    // A preconfigured TLS config gets no ALPN from reqwest; offer HTTP/2 like the default does.
    config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    Ok(config)
}

/// The platform verifier, created on first use. Handshake signatures need no trust store and
/// are checked the same way the platform verifier checks them.
#[derive(Debug)]
struct LazyVerifier {
    provider: Arc<CryptoProvider>,
    platform: OnceLock<Result<rustls_platform_verifier::Verifier, rustls::Error>>,
}

impl LazyVerifier {
    fn platform(&self) -> Result<&rustls_platform_verifier::Verifier, rustls::Error> {
        self.platform
            .get_or_init(|| rustls_platform_verifier::Verifier::new(self.provider.clone()))
            .as_ref()
            .map_err(Clone::clone)
    }
}

impl ServerCertVerifier for LazyVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        self.platform()?
            .verify_server_cert(end_entity, intermediates, server_name, ocsp_response, now)
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider.signature_verification_algorithms.supported_schemes()
    }
}
