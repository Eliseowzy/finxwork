//! Newline-delimited framing with a size limit. An oversized line is skipped, not buffered.

use bytes::Bytes;
use bytes::BytesMut;
use std::io;
use tokio::io::AsyncRead;
use tokio::io::AsyncReadExt;

/// Bytes asked of the reader at first. Reads that fill the buffer double the next one, up to
/// `READ_MAX`; short reads halve it again, so an idle connection keeps a small buffer.
const READ_MIN: usize = 4 * 1024;
const READ_MAX: usize = 64 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub enum Frame {
    /// One line without its terminator (`\n` or `\r\n`). Never empty or blank.
    Line(Bytes),
    /// A line longer than the limit was skipped.
    Oversize,
}

pub struct FrameReader<R> {
    inner: R,
    buf: BytesMut,
    max: usize,
    /// Bytes already searched for a newline.
    scanned: usize,
    /// Inside an oversized line; drop bytes until the next newline.
    discarding: bool,
    read_size: usize,
}

impl<R: AsyncRead + Unpin> FrameReader<R> {
    pub fn new(inner: R, max_frame_bytes: usize) -> Self {
        Self {
            inner,
            buf: BytesMut::new(),
            max: max_frame_bytes,
            scanned: 0,
            discarding: false,
            read_size: READ_MIN,
        }
    }

    /// The next frame, or `None` at end of input.
    pub async fn next(&mut self) -> io::Result<Option<Frame>> {
        loop {
            if let Some(pos) = memchr::memchr(b'\n', &self.buf[self.scanned..]) {
                let end = self.scanned + pos;
                let mut line = self.buf.split_to(end + 1);
                self.scanned = 0;
                if self.discarding {
                    self.discarding = false;
                    return Ok(Some(Frame::Oversize));
                }
                line.truncate(end);
                if line.last() == Some(&b'\r') {
                    line.truncate(end - 1);
                }
                if line.len() > self.max {
                    return Ok(Some(Frame::Oversize));
                }
                if line.iter().all(u8::is_ascii_whitespace) {
                    continue;
                }
                return Ok(Some(Frame::Line(line.freeze())));
            }
            self.scanned = self.buf.len();
            if self.buf.len() > self.max {
                self.discarding = true;
                self.buf.clear();
                self.scanned = 0;
            }
            // Give back a buffer that grew for a burst once it has been consumed.
            if self.buf.is_empty() && self.buf.capacity() > 2 * self.read_size {
                self.buf = BytesMut::new();
            }
            self.buf.reserve(self.read_size);
            let spare = self.buf.capacity() - self.buf.len();
            let read = self.inner.read_buf(&mut self.buf).await?;
            self.read_size = if read == spare {
                (self.read_size * 2).min(READ_MAX)
            } else {
                (self.read_size / 2).max(READ_MIN)
            };
            if read == 0 {
                if self.discarding {
                    self.discarding = false;
                    return Ok(Some(Frame::Oversize));
                }
                if self.buf.iter().all(u8::is_ascii_whitespace) {
                    return Ok(None);
                }
                // A last line without a terminator.
                let line = self.buf.split();
                self.scanned = 0;
                return Ok(Some(Frame::Line(line.freeze())));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn frames(input: &[u8], max: usize) -> Vec<Frame> {
        let mut reader = FrameReader::new(input, max);
        let mut out = Vec::new();
        while let Some(frame) = reader.next().await.unwrap() {
            out.push(frame);
        }
        out
    }

    fn line(s: &str) -> Frame {
        Frame::Line(Bytes::copy_from_slice(s.as_bytes()))
    }

    #[tokio::test]
    async fn splits_lines_and_skips_blank_ones() {
        let got = frames(b"{\"a\":1}\n\n  \r\n{\"b\":2}\r\n{\"c\":3}", 1024).await;
        assert_eq!(got, vec![line("{\"a\":1}"), line("{\"b\":2}"), line("{\"c\":3}")]);
    }

    #[tokio::test]
    async fn skips_oversized_lines_and_keeps_going() {
        let mut input = vec![b'x'; 200_000];
        input.extend_from_slice(b"\n{\"ok\":true}\n");
        let got = frames(&input, 1000).await;
        assert_eq!(got, vec![Frame::Oversize, line("{\"ok\":true}")]);
        let got = frames(b"0123456789abc\nshort\n", 10).await;
        assert_eq!(got, vec![Frame::Oversize, line("short")]);
    }

    #[tokio::test]
    async fn the_buffer_grows_for_bursts_and_shrinks_when_idle() {
        let (client, server) = tokio::io::duplex(1 << 20);
        let mut reader = FrameReader::new(server, 1 << 20);
        let mut client = client;
        use tokio::io::AsyncWriteExt;
        let big = format!("{}\n", "x".repeat(300_000));
        client.write_all(big.as_bytes()).await.unwrap();
        assert!(matches!(reader.next().await.unwrap(), Some(Frame::Line(line)) if line.len() == 300_000));
        assert!(reader.buf.capacity() >= 300_000 || reader.buf.is_empty());
        for _ in 0..4 {
            client.write_all(b"{\"small\":1}\n").await.unwrap();
            assert_eq!(reader.next().await.unwrap(), Some(line("{\"small\":1}")));
        }
        assert!(reader.buf.capacity() <= 2 * READ_MIN, "capacity {}", reader.buf.capacity());
    }

    #[tokio::test]
    async fn reassembles_lines_split_across_reads() {
        let (client, server) = tokio::io::duplex(8);
        let writer = tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            let mut client = client;
            for chunk in [&b"{\"par"[..], b"t\":1}\n{\"next", b"\":2}\n"] {
                client.write_all(chunk).await.unwrap();
                tokio::task::yield_now().await;
            }
        });
        let mut reader = FrameReader::new(server, 1024);
        assert_eq!(reader.next().await.unwrap(), Some(line("{\"part\":1}")));
        assert_eq!(reader.next().await.unwrap(), Some(line("{\"next\":2}")));
        writer.await.unwrap();
        assert_eq!(reader.next().await.unwrap(), None);
    }
}
