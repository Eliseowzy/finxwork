//! Bounded Qoder framing compatibility, isolated from ordinary OpenAI providers.
use finx_llm::{ErrorKind, LlmError, api::openai_chat::ChatEvents};
const LIMIT: usize = 1024 * 1024;
fn error(code: &str) -> LlmError {
    let mut e = LlmError::new(ErrorKind::Protocol, "Qoder 返回了无法识别的模型流");
    e.provider_code = Some(code.into());
    e
}
#[derive(Default)]
struct Frame {
    lines: Vec<String>,
    bytes: usize,
}
impl Frame {
    fn push(&mut self, line: &[u8]) -> Result<Option<String>, LlmError> {
        let line = std::str::from_utf8(line)
            .map_err(|_| error("invalid_stream_utf8"))?
            .trim_end_matches('\r');
        if line.is_empty() {
            return self.finish();
        }
        if line.starts_with(':')
            || line.starts_with("event:")
            || line.starts_with("id:")
            || line.starts_with("retry:")
        {
            return Ok(None);
        }
        let data = if let Some(data) = line.strip_prefix("data:") {
            data.strip_prefix(' ').unwrap_or(data)
        } else if !self.lines.is_empty() {
            line
        } else {
            return Err(error("unexpected_sse_line"));
        };
        self.bytes += data.len();
        if self.bytes > LIMIT {
            return Err(error("sse_event_too_large"));
        }
        self.lines.push(data.into());
        Ok(None)
    }
    fn finish(&mut self) -> Result<Option<String>, LlmError> {
        if self.lines.is_empty() {
            return Ok(None);
        }
        let standard = self.lines.join("\n");
        let compact = self.lines.concat();
        self.lines.clear();
        self.bytes = 0;
        if standard.trim() == "[DONE]" {
            return Ok(Some("[DONE]".into()));
        }
        let parsed = serde_json::from_str::<serde_json::Value>(&standard)
            .map(|v| (standard, v))
            .or_else(|_| serde_json::from_str::<serde_json::Value>(&compact).map(|v| (compact, v)))
            .map_err(|_| error("invalid_stream_json"))?;
        if parsed.1.is_null() {
            return Ok(None);
        }
        if !parsed.1.is_object() {
            return Err(error("unexpected_sse_value"));
        }
        Ok(Some(parsed.0))
    }
}
pub(super) fn decode(mut response: reqwest::Response) -> ChatEvents {
    Box::pin(async_stream::stream! {
     let mut pending=Vec::new();let mut frame=Frame::default();
     loop{
      let chunk=match response.chunk().await{Ok(Some(v))=>v,Ok(None)=>break,Err(_)=>{yield Err(error("stream_read_failed"));return;}};
      for byte in chunk {
       if byte==b'\n'{match frame.push(&pending){Ok(Some(event))=>yield Ok(event),Ok(None)=>{},Err(e)=>{yield Err(e);return;}}pending.clear();}
       else{pending.push(byte);if pending.len()+frame.bytes>LIMIT{yield Err(error("sse_event_too_large"));return;}}
      }
     }
     if !pending.is_empty(){match frame.push(&pending){Ok(Some(event))=>yield Ok(event),Ok(None)=>{},Err(e)=>{yield Err(e);return;}}}
     match frame.finish(){Ok(Some(event))=>yield Ok(event),Ok(None)=>{},Err(e)=>yield Err(e)}
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restores_only_one_bounded_event() {
        let mut f = Frame::default();
        f.push(b"data: {\"choices\":[{\"delta\":{\"content\":\"hel")
            .unwrap();
        f.push(b"lo\"}}]}").unwrap();
        let v = f.push(b"").unwrap().unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&v).unwrap()["choices"][0]["delta"]["content"],
            "hello"
        );
        assert!(f.push(b"data: null").unwrap().is_none());
        assert!(f.push(b"").unwrap().is_none());
    }
    #[test]
    fn malformed_event_cannot_cross_into_next() {
        let mut f = Frame::default();
        f.push(b"data: {broken").unwrap();
        assert!(f.push(b"").is_err());
    }
    #[test]
    fn caps_buffer_and_handles_unicode() {
        let mut f = Frame::default();
        f.push("data: {\"x\":\"你好\"}".as_bytes()).unwrap();
        assert!(f.push(b"").unwrap().is_some());
        assert!(f.push(&vec![b'x'; LIMIT + 1]).is_err());
    }
}
