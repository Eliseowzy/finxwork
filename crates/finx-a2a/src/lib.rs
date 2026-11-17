//! An A2A client (docs/kernel/bot-contacts-design.md §5): reading an agent's card, talking to it
//! over JSON-RPC, and the [`finx_core::Peer`] an external bot's session uses.

pub mod card;
pub mod client;
pub mod events;
pub mod net;
pub mod peer;

pub use card::Card;
pub use card::CardError;
pub use card::icon;
pub use card::CardOptions;
pub use client::Auth;
pub use client::Client;
pub use client::ClientError;
pub use client::ClientOptions;
pub use client::Endpoint;
pub use peer::A2aPeer;
pub use peer::Source;
