use finx_llm::{LlmStream, WireApi, WireRequest, api::openai_chat::OpenAiChatApi};
use std::sync::Arc;

pub(super) struct Http;
impl WireApi for Http {
    fn id(&self) -> &'static str {
        "openai-chat"
    }
    fn stream(&self, mut req: WireRequest) -> LlmStream {
        let model = Arc::make_mut(&mut req.model);
        model.compat.max_tokens_field = Some(finx_llm::model::MaxTokensField::MaxTokens);
        model.compat.stream_usage = Some(true);
        let message = uuid::Uuid::new_v4().to_string();
        model.headers.insert("X-Request-ID".into(), message.clone());
        model
            .headers
            .insert("X-Conversation-Message-ID".into(), message);
        // Keep IDs stable through a tool loop; never send local paths/session IDs.
        let account = req
            .credentials
            .headers
            .get("X-User-Id")
            .map(String::as_str)
            .unwrap_or("");
        let first = req
            .context
            .messages
            .iter()
            .find(|m| matches!(m, finx_llm::Message::User(_)))
            .and_then(|m| serde_json::to_string(m).ok())
            .unwrap_or_default();
        let conversation = req
            .options
            .cache_key
            .clone()
            .unwrap_or_else(|| format!("{}:{first}", req.context.system));
        let turn = req
            .context
            .messages
            .iter()
            .enumerate()
            .rev()
            .find(|(_, m)| matches!(m, finx_llm::Message::User(_)))
            .and_then(|(index, m)| serde_json::to_string(&(index, m)).ok());
        for (header, id) in [
            ("X-Conversation-ID", Some(conversation.as_str())),
            ("X-Conversation-Request-ID", turn.as_deref()),
        ] {
            let value = id
                .map(|id| {
                    crate::platform::digest(
                        format!("{}:{account}:{conversation}:{header}:{id}", model.provider)
                            .as_bytes(),
                    )
                })
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            model.headers.insert(header.into(), value);
        }
        OpenAiChatApi::stream_strict(req)
    }
}
