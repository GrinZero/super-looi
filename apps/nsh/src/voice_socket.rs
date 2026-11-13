//! App-owned transport for voice providers whose Authorization header is
//! intentionally refused by NSH's general-purpose `websocket` module.
use futures_util::{
    SinkExt, StreamExt,
    stream::{SplitSink, SplitStream},
};
use nsh_core::prelude::*;
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{Mutex as AsyncMutex, watch};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream,
    tungstenite::{self, Message, client::IntoClientRequest},
};

type Socket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;
const IO_DEADLINE: Duration = Duration::from_secs(15);

fn failure(stage: &str, error: tungstenite::Error) -> JsError {
    let code = match &error {
        tungstenite::Error::Http(response) => format!("HTTP_{}", response.status().as_u16()),
        tungstenite::Error::Io(error) => error
            .raw_os_error()
            .map(|code| format!("OS_{code}"))
            .unwrap_or_else(|| format!("{:?}", error.kind())),
        tungstenite::Error::Tls(_) => "TLS_ERROR".into(),
        _ => "WEBSOCKET_ERROR".into(),
    };
    let mut reason = error.to_string();
    if let tungstenite::Error::Http(response) = &error {
        if let Some(body) = response.body() {
            reason.push_str(": ");
            reason.push_str(&String::from_utf8_lossy(body));
        }
    }
    let mut source = std::error::Error::source(&error);
    while let Some(cause) = source {
        reason.push_str("; caused by: ");
        reason.push_str(&cause.to_string());
        source = cause.source();
    }
    JsError::Error(format!("{stage}: {reason}")).with_code(&code)
}
fn closed() -> JsError {
    JsError::Error("Voice WebSocket is closed".into()).with_code("ERR_SOCKET_CLOSED")
}
struct State {
    request: Mutex<Option<tungstenite::handshake::client::Request>>,
    reader: AsyncMutex<Option<SplitStream<Socket>>>,
    writer: AsyncMutex<Option<SplitSink<Socket, Message>>>,
    closed: watch::Sender<bool>,
}
/// A text or binary realtime frame, retaining PCM without JSON encoding.
#[derive(Clone, JsObject)]
pub struct VoiceSocketFrame {
    pub text: Option<String>,
    pub bytes: Option<Vec<u8>>,
}
/// Direct cloud WebSocket owned by the App and bounded by its network grants.
#[class]
pub struct VoiceWebSocket {
    state: Arc<State>,
}
#[class]
impl VoiceWebSocket {
    /// Prepare a provider request, including Authorization, without network I/O.
    pub fn new(
        url: String,
        headers: BTreeMap<String, String>,
        sys: System,
    ) -> Result<Self, JsError> {
        if !sys.access.allows_websocket(&url) {
            return Err(
                JsError::Error(format!("Voice WebSocket URL is not granted: {url}"))
                    .with_code("ERR_ACCESS_DENIED"),
            );
        }
        sys.check_connection(&url)?;
        let mut request = url
            .into_client_request()
            .map_err(|error| failure("request", error))?;
        for (name, value) in headers {
            let name = tungstenite::http::HeaderName::from_bytes(name.as_bytes())
                .map_err(|error| JsError::Type(format!("Voice header name: {error}")))?;
            let value = tungstenite::http::HeaderValue::from_str(&value)
                .map_err(|error| JsError::Type(format!("Voice header value: {error}")))?;
            request.headers_mut().insert(name, value);
        }
        Ok(Self {
            state: Arc::new(State {
                request: Mutex::new(Some(request)),
                reader: AsyncMutex::new(None),
                writer: AsyncMutex::new(None),
                closed: watch::channel(false).0,
            }),
        })
    }
    /// Complete TLS and the authenticated HTTP upgrade on the device.
    pub async fn open(this: Instance<Self>) -> Result<(), JsError> {
        let state = this.with(|socket| socket.state.clone());
        let request = state.request.lock().unwrap().take().ok_or_else(closed)?;
        let (socket, _) =
            tokio::time::timeout(IO_DEADLINE, tokio_tungstenite::connect_async(request))
                .await
                .map_err(|_| {
                    JsError::Error("Voice WebSocket connect exceeded 15000ms".into())
                        .with_code("ETIMEDOUT")
                })?
                .map_err(|error| failure("connect", error))?;
        if *state.closed.borrow() {
            return Err(closed());
        }
        let (writer, reader) = socket.split();
        *state.writer.lock().await = Some(writer);
        *state.reader.lock().await = Some(reader);
        Ok(())
    }
    /// Await a payload or null after closing; remote failures retain their codes.
    pub async fn read(this: Instance<Self>) -> Result<Option<VoiceSocketFrame>, JsError> {
        let state = this.with(|socket| socket.state.clone());
        let mut cancelled = state.closed.subscribe();
        if *cancelled.borrow() {
            return Ok(None);
        }
        let mut guard = state.reader.lock().await;
        let reader = guard.as_mut().ok_or_else(closed)?;
        loop {
            let frame = tokio::select! {
                _ = cancelled.changed() => { return Ok(None); }
                frame = reader.next() => frame,
            };
            match frame {
                Some(Ok(Message::Text(text))) => {
                    return Ok(Some(VoiceSocketFrame {
                        text: Some(text.to_string()),
                        bytes: None,
                    }));
                }
                Some(Ok(Message::Binary(bytes))) => {
                    return Ok(Some(VoiceSocketFrame {
                        text: None,
                        bytes: Some(bytes.to_vec()),
                    }));
                }
                Some(Ok(Message::Close(Some(frame)))) => {
                    return Err(JsError::Error(format!(
                        "Remote WebSocket close: {} {}",
                        frame.code, frame.reason
                    ))
                    .with_code(&format!("WS_{}", u16::from(frame.code))));
                }
                Some(Ok(Message::Close(None))) => {
                    return Err(
                        JsError::Error("Remote WebSocket close without status".into())
                            .with_code("WS_1005"),
                    );
                }
                None => {
                    return Err(
                        JsError::Error("Remote WebSocket stream ended".into()).with_code("WS_EOF")
                    );
                }
                Some(Err(error)) => return Err(failure("read", error)),
                // Flush the queued pong even when the user is not sending audio.
                Some(Ok(Message::Ping(_))) => {
                    if let Some(writer) = state.writer.lock().await.as_mut() {
                        writer
                            .flush()
                            .await
                            .map_err(|error| failure("pong", error))?;
                    }
                }
                _ => {}
            }
        }
    }
    /// Send a JSON protocol frame.
    pub async fn write_text(this: Instance<Self>, text: String) -> Result<(), JsError> {
        let state = this.with(|socket| socket.state.clone());
        write(state, Message::Text(text.into())).await
    }
    /// Send PCM as a binary frame.
    pub async fn write_bytes(this: Instance<Self>, bytes: Vec<u8>) -> Result<(), JsError> {
        let state = this.with(|socket| socket.state.clone());
        write(state, Message::Binary(bytes.into())).await
    }
    /// Cancel pending reads and release the stream halves.
    pub async fn close(this: Instance<Self>) -> Result<(), JsError> {
        let state = this.with(|socket| socket.state.clone());
        state.closed.send_replace(true);
        state.reader.lock().await.take();
        let writer = state.writer.lock().await.take();
        if let Some(mut writer) = writer {
            tokio::time::timeout(IO_DEADLINE, writer.close())
                .await
                .map_err(|_| {
                    JsError::Error("Voice WebSocket close exceeded 15000ms".into())
                        .with_code("ETIMEDOUT")
                })?
                .map_err(|error| failure("close", error))?;
        }
        Ok(())
    }
}
async fn write(state: Arc<State>, message: Message) -> Result<(), JsError> {
    if *state.closed.borrow() {
        return Err(closed());
    }
    let mut guard = state.writer.lock().await;
    let writer = guard.as_mut().ok_or_else(closed)?;
    tokio::time::timeout(IO_DEADLINE, writer.send(message))
        .await
        .map_err(|_| {
            JsError::Error("Voice WebSocket write exceeded 15000ms".into()).with_code("ETIMEDOUT")
        })?
        .map_err(|error| failure("write", error))
}
impl Drop for VoiceWebSocket {
    fn drop(&mut self) {
        self.state.closed.send_replace(true);
    }
}
