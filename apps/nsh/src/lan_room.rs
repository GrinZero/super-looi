//! Foreground-bound local Wi-Fi HTTP companion room host (`LanRoomHost`).
//! Serves mobile web companion clients over LAN/hotspot IPv4 with bounded concurrency,
//! `16 KiB` request body caps, native `/api/wait` revision long-polling, and immediate background teardown.

use nsh_core::prelude::*;
use serde_json::{Map, Value, json};
use std::{
    collections::{HashMap, VecDeque},
    net::{Ipv4Addr, SocketAddr, UdpSocket},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{Notify, Semaphore, oneshot, watch},
    task::JoinHandle,
    time::timeout,
};

const MAX_CONCURRENT_CONNECTIONS: usize = 24;
const MAX_PENDING_QUEUE: usize = 32;
const MAX_HEADER_BYTES: usize = 8 * 1024;
const MAX_BODY_BYTES: usize = 16 * 1024;
const HEADER_READ_TIMEOUT: Duration = Duration::from_secs(10);
const BODY_READ_TIMEOUT: Duration = Duration::from_secs(10);
const HANDLER_RESPONSE_TIMEOUT: Duration = Duration::from_secs(10);
const DEFAULT_WAIT_TIMEOUT_MS: u64 = 20_000;
const MIN_WAIT_TIMEOUT_MS: u64 = 50;
const MAX_WAIT_TIMEOUT_MS: u64 = 25_000;

/// Connection endpoint metadata for an opened LAN companion room.
#[derive(Clone, Debug, JsObject)]
pub struct NativeLanRoomInfo {
    /// Unique identifier for this LAN room session.
    pub room_id: String,
    /// Bound local TCP port on `0.0.0.0`.
    pub port: u32,
    /// Best-effort LAN or Personal Hotspot IPv4 address (`127.0.0.1` fallback when offline).
    pub lan_ipv4: String,
    /// Reachable HTTP root URL for QR codes and mobile browsers (e.g. `http://192.168.1.20:54120`).
    pub base_url: String,
}

/// One parsed HTTP `GET` or `POST` request bridged from `LanRoomHost` to TypeScript.
#[derive(Clone, Debug, JsObject)]
pub struct NativeLanHttpRequest {
    /// Per-request correlation ticket used by `respondRequest`.
    pub request_id: String,
    /// Uppercase HTTP method (`"GET"` or `"POST"`).
    pub method: String,
    /// Decoded request URL pathname starting with `"/"`.
    pub path: String,
    /// JSON object string containing decoded URL query string parameters.
    pub query_json: String,
    /// JSON object string containing lowercased HTTP request headers.
    pub headers_json: String,
    /// UTF-8 request body string (`<= 16 KiB`).
    pub body_text: String,
    /// Peer socket address (`ip:port`).
    pub remote_addr: String,
}

#[derive(Debug)]
struct BridgeHttpResponse {
    status: u16,
    content_type: String,
    cache_control: String,
    body: Vec<u8>,
}

impl BridgeHttpResponse {
    fn json(status: u16, payload: Value) -> Self {
        Self {
            status,
            content_type: "application/json; charset=utf-8".to_string(),
            cache_control: "no-store".to_string(),
            body: payload.to_string().into_bytes(),
        }
    }

    fn error_json(status: u16, stage: &str, code: &str, reason: &str) -> Self {
        Self::json(
            status,
            json!({
                "ok": false,
                "stage": stage,
                "code": code,
                "reason": reason,
                "error": {
                    "stage": stage,
                    "code": code,
                    "reason": reason,
                }
            }),
        )
    }
}

struct QueuedRequest {
    request: NativeLanHttpRequest,
    responder: oneshot::Sender<BridgeHttpResponse>,
}

#[derive(Default)]
struct RoomBridgeState {
    pending: VecDeque<QueuedRequest>,
    inflight: HashMap<String, oneshot::Sender<BridgeHttpResponse>>,
    active_conns: HashMap<u64, JoinHandle<()>>,
}

pub(crate) struct RoomSession {
    pub(crate) id: String,
    pub(crate) port: u16,
    closed: AtomicBool,
    closed_by_background: AtomicBool,
    next_conn_id: AtomicU64,
    next_req_seq: AtomicU64,
    revision_tx: watch::Sender<(u64, bool)>,
    close_notify: Notify,
    queue_notify: Notify,
    conn_semaphore: Arc<Semaphore>,
    state: Mutex<RoomBridgeState>,
    accept_task: Mutex<Option<JoinHandle<()>>>,
}

impl RoomSession {
    pub(crate) async fn bind(
        requested_id: Option<&str>,
        preferred_port: Option<u16>,
    ) -> Result<Arc<Self>, String> {
        let id = requested_id
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| format!("lan_{}", uuid::Uuid::new_v4()));

        let listener = match preferred_port.filter(|p| *p > 0) {
            Some(port) => match TcpListener::bind(("0.0.0.0", port)).await {
                Ok(l) => l,
                Err(_) => TcpListener::bind("0.0.0.0:0").await.map_err(|err| {
                    format!(
                        "[stage=lan_room.open code=ERR_LAN_ROOM_BIND_FAILED] Failed to bind TCP listener on 0.0.0.0:0 after preferred port {port} fallback: {err}"
                    )
                })?,
            },
            None => TcpListener::bind("0.0.0.0:0").await.map_err(|err| {
                format!(
                    "[stage=lan_room.open code=ERR_LAN_ROOM_BIND_FAILED] Failed to bind TCP listener on 0.0.0.0:0: {err}"
                )
            })?,
        };
        let local_addr = listener.local_addr().map_err(|err| {
            format!(
                "[stage=lan_room.open code=ERR_LAN_ROOM_LOCAL_ADDR] Failed to read bound TCP port: {err}"
            )
        })?;
        let port = local_addr.port();
        let (revision_tx, _) = watch::channel((0u64, false));

        let session = Arc::new(Self {
            id,
            port,
            closed: AtomicBool::new(false),
            closed_by_background: AtomicBool::new(false),
            next_conn_id: AtomicU64::new(1),
            next_req_seq: AtomicU64::new(1),
            revision_tx,
            close_notify: Notify::new(),
            queue_notify: Notify::new(),
            conn_semaphore: Arc::new(Semaphore::new(MAX_CONCURRENT_CONNECTIONS)),
            state: Mutex::new(RoomBridgeState::default()),
            accept_task: Mutex::new(None),
        });

        let weak = Arc::downgrade(&session);
        let accept_handle = tokio::spawn(async move {
            loop {
                let Some(room) = weak.upgrade() else {
                    break;
                };
                if room.closed.load(Ordering::Acquire) {
                    break;
                }
                let close_fut = room.close_notify.notified();
                tokio::pin!(close_fut);
                close_fut.as_mut().enable();
                if room.closed.load(Ordering::Acquire) {
                    break;
                }

                let accepted = tokio::select! {
                    _ = &mut close_fut => break,
                    res = listener.accept() => res,
                };

                let (mut stream, peer_addr) = match accepted {
                    Ok(pair) => pair,
                    Err(_) => {
                        tokio::time::sleep(Duration::from_millis(10)).await;
                        continue;
                    }
                };

                let permit = match room.conn_semaphore.clone().try_acquire_owned() {
                    Ok(p) => p,
                    Err(_) => {
                        let busy = BridgeHttpResponse::error_json(
                            503,
                            "lan_room.accept",
                            "ERR_LAN_ROOM_BUSY",
                            "Too many concurrent companion connections (max 24)",
                        );
                        let _ = write_http_response(&mut stream, &busy).await;
                        continue;
                    }
                };

                let conn_id = room.next_conn_id.fetch_add(1, Ordering::Relaxed);
                let conn_room = room.clone();
                let handle = tokio::spawn(async move {
                    let _permit = permit;
                    let _ = stream.set_nodelay(true);
                    handle_connection(conn_room.clone(), stream, peer_addr).await;
                    conn_room.state.lock().unwrap().active_conns.remove(&conn_id);
                });

                let mut guard = room.state.lock().unwrap();
                if room.closed.load(Ordering::Acquire) {
                    handle.abort();
                    break;
                }
                guard.active_conns.insert(conn_id, handle);
            }
        });

        *session.accept_task.lock().unwrap() = Some(accept_handle);
        if session.closed.load(Ordering::Acquire)
            && let Some(task) = session.accept_task.lock().unwrap().take()
        {
            task.abort();
        }
        Ok(session)
    }

    pub(crate) fn info(&self) -> NativeLanRoomInfo {
        let lan_ipv4 = detect_lan_ipv4();
        let base_url = format!("http://{}:{}", lan_ipv4, self.port);
        NativeLanRoomInfo {
            room_id: self.id.clone(),
            port: self.port as u32,
            lan_ipv4,
            base_url,
        }
    }

    pub(crate) async fn next_request(self: Arc<Self>) -> Result<NativeLanHttpRequest, String> {
        loop {
            let notified = self.queue_notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();

            {
                let mut state = self.state.lock().unwrap();
                if self.closed.load(Ordering::Acquire) {
                    let code = if self.closed_by_background.load(Ordering::Acquire) {
                        "ERR_LAN_ROOM_BACKGROUNDED"
                    } else {
                        "ERR_LAN_ROOM_CLOSED"
                    };
                    let reason = if self.closed_by_background.load(Ordering::Acquire) {
                        format!("LAN room \"{}\" closed due to app backgrounding", self.id)
                    } else {
                        format!("LAN room \"{}\" closed", self.id)
                    };
                    return Err(format!("[stage=lan_room.nextRequest code={code}] {reason}"));
                }
                if let Some(queued) = state.pending.pop_front() {
                    state
                        .inflight
                        .insert(queued.request.request_id.clone(), queued.responder);
                    return Ok(queued.request);
                }
            }

            notified.await;
        }
    }

    pub(crate) fn respond_request(
        &self,
        request_id: &str,
        status: i32,
        content_type: String,
        cache_control: String,
        body: String,
    ) {
        let responder = self.state.lock().unwrap().inflight.remove(request_id);
        if let Some(tx) = responder {
            let clamped_status = status.clamp(100, 599) as u16;
            let _ = tx.send(BridgeHttpResponse {
                status: clamped_status,
                content_type: sanitize_header_value(&content_type, "application/json; charset=utf-8"),
                cache_control: sanitize_header_value(&cache_control, "no-store"),
                body: body.into_bytes(),
            });
        }
    }

    pub(crate) fn notify_revision(&self, revision: u64) {
        if self.closed.load(Ordering::Acquire) {
            return;
        }
        let _ = self.revision_tx.send_replace((revision, true));
    }

    pub(crate) fn close(&self, by_background: bool) {
        if by_background {
            self.closed_by_background.store(true, Ordering::Release);
        }
        if self.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        self.close_notify.notify_waiters();
        self.queue_notify.notify_waiters();

        if let Some(accept) = self.accept_task.lock().unwrap().take() {
            accept.abort();
        }

        let (conns, pending, inflight) = {
            let mut state = self.state.lock().unwrap();
            let conns: Vec<_> = state.active_conns.drain().map(|(_, h)| h).collect();
            let pending: Vec<_> = state.pending.drain(..).collect();
            let inflight: Vec<_> = state.inflight.drain().map(|(_, tx)| tx).collect();
            (conns, pending, inflight)
        };

        drop(pending);
        drop(inflight);
        for conn in conns {
            conn.abort();
        }
    }
}

impl Drop for RoomSession {
    fn drop(&mut self) {
        self.close(false);
    }
}

struct ParsedHttpRequest {
    method: String,
    path: String,
    query: Map<String, Value>,
    headers: Map<String, Value>,
    body_text: String,
}

enum ReadRequestOutcome {
    ClientClosedIdle,
    Ready(ParsedHttpRequest),
    ImmediateResponse {
        response: BridgeHttpResponse,
        drain_hint_bytes: usize,
    },
}

async fn handle_connection(room: Arc<RoomSession>, mut stream: TcpStream, peer_addr: SocketAddr) {
    let close_fut = room.close_notify.notified();
    tokio::pin!(close_fut);
    close_fut.as_mut().enable();

    if room.closed.load(Ordering::Acquire) {
        return;
    }

    let outcome = tokio::select! {
        _ = &mut close_fut => return,
        res = read_http_request(&mut stream) => res,
    };

    let req = match outcome {
        ReadRequestOutcome::ClientClosedIdle => return,
        ReadRequestOutcome::ImmediateResponse {
            response,
            drain_hint_bytes,
        } => {
            if drain_hint_bytes > 0 {
                drain_excess_body(&mut stream, drain_hint_bytes.min(65_536)).await;
            }
            let _ = write_http_response(&mut stream, &response).await;
            return;
        }
        ReadRequestOutcome::Ready(req) => req,
    };

    if req.method == "OPTIONS" {
        let preflight = BridgeHttpResponse {
            status: 204,
            content_type: "text/plain; charset=utf-8".to_string(),
            cache_control: "no-store".to_string(),
            body: Vec::new(),
        };
        let _ = write_http_response(&mut stream, &preflight).await;
        return;
    }

    if req.method != "GET" && req.method != "POST" {
        let method_err = BridgeHttpResponse::error_json(
            405,
            "lan_room.http",
            "ERR_LAN_METHOD_NOT_ALLOWED",
            &format!("Unsupported HTTP method \"{}\"", req.method),
        );
        let _ = write_http_response(&mut stream, &method_err).await;
        return;
    }

    if req.method == "GET" && req.path == "/api/wait" {
        let resp = handle_wait_request(&room, &req.query).await;
        let _ = write_http_response(&mut stream, &resp).await;
        return;
    }

    let request_id = format!(
        "req_{}_{}",
        room.id,
        room.next_req_seq.fetch_add(1, Ordering::Relaxed)
    );
    let native_req = NativeLanHttpRequest {
        request_id: request_id.clone(),
        method: req.method,
        path: req.path,
        query_json: Value::Object(req.query).to_string(),
        headers_json: Value::Object(req.headers).to_string(),
        body_text: req.body_text,
        remote_addr: peer_addr.to_string(),
    };

    let (tx, rx) = oneshot::channel::<BridgeHttpResponse>();
    let enqueue_err = {
        let mut state = room.state.lock().unwrap();
        if room.closed.load(Ordering::Acquire) {
            Some(BridgeHttpResponse::error_json(
                503,
                "lan_room.bridge",
                "ERR_LAN_ROOM_CLOSED",
                "LAN room is closed",
            ))
        } else if state.pending.len() >= MAX_PENDING_QUEUE {
            Some(BridgeHttpResponse::error_json(
                429,
                "lan_room.bridge",
                "ERR_LAN_QUEUE_FULL",
                "LAN room request queue is full",
            ))
        } else {
            state.pending.push_back(QueuedRequest {
                request: native_req,
                responder: tx,
            });
            None
        }
    };
    if let Some(err_resp) = enqueue_err {
        let _ = write_http_response(&mut stream, &err_resp).await;
        return;
    }
    room.queue_notify.notify_one();

    let close_wait = room.close_notify.notified();
    tokio::pin!(close_wait);
    close_wait.as_mut().enable();

    let response = if room.closed.load(Ordering::Acquire) {
        BridgeHttpResponse::error_json(
            503,
            "lan_room.bridge",
            "ERR_LAN_ROOM_CLOSED",
            "LAN room closed",
        )
    } else {
        tokio::select! {
            _ = &mut close_wait => {
                BridgeHttpResponse::error_json(
                    503,
                    "lan_room.bridge",
                    "ERR_LAN_ROOM_CLOSED",
                    "LAN room closed",
                )
            }
            res = timeout(HANDLER_RESPONSE_TIMEOUT, rx) => {
                match res {
                    Ok(Ok(reply)) => reply,
                    Ok(Err(_)) => BridgeHttpResponse::error_json(
                        503,
                        "lan_room.bridge",
                        "ERR_LAN_ROOM_CLOSED",
                        "LAN room handler channel closed",
                    ),
                    Err(_) => {
                        room.state.lock().unwrap().inflight.remove(&request_id);
                        BridgeHttpResponse::error_json(
                            504,
                            "lan_room.bridge",
                            "ERR_LAN_HANDLER_TIMEOUT",
                            "Timed out waiting for plugin HTTP response",
                        )
                    }
                }
            }
        }
    };

    let _ = write_http_response(&mut stream, &response).await;
}

async fn handle_wait_request(room: &Arc<RoomSession>, query: &Map<String, Value>) -> BridgeHttpResponse {
    let since_rev = query
        .get("sinceRev")
        .and_then(Value::as_str)
        .and_then(|s| s.trim().parse::<u64>().ok())
        .unwrap_or(0);
    let timeout_ms = query
        .get("timeoutMs")
        .and_then(Value::as_str)
        .and_then(|s| s.trim().parse::<u64>().ok())
        .unwrap_or(DEFAULT_WAIT_TIMEOUT_MS)
        .clamp(MIN_WAIT_TIMEOUT_MS, MAX_WAIT_TIMEOUT_MS);

    let mut rx = room.revision_tx.subscribe();
    let close_fut = room.close_notify.notified();
    tokio::pin!(close_fut);
    close_fut.as_mut().enable();

    if room.closed.load(Ordering::Acquire) {
        return BridgeHttpResponse::error_json(
            503,
            "lan_room.wait",
            "ERR_LAN_ROOM_CLOSED",
            "LAN room closed",
        );
    }

    let (cur_rev, initialized) = *rx.borrow_and_update();
    if initialized && cur_rev > since_rev {
        return BridgeHttpResponse::json(
            200,
            json!({
                "ok": true,
                "revision": cur_rev,
                "changed": true,
            }),
        );
    }

    tokio::select! {
        _ = &mut close_fut => {
            BridgeHttpResponse::error_json(
                503,
                "lan_room.wait",
                "ERR_LAN_ROOM_CLOSED",
                "LAN room closed",
            )
        }
        changed = rx.changed() => {
            if changed.is_err() || room.closed.load(Ordering::Acquire) {
                BridgeHttpResponse::error_json(
                    503,
                    "lan_room.wait",
                    "ERR_LAN_ROOM_CLOSED",
                    "LAN room closed",
                )
            } else {
                let (next_rev, next_init) = *rx.borrow_and_update();
                let reported = if next_init { next_rev } else { since_rev };
                BridgeHttpResponse::json(
                    200,
                    json!({
                        "ok": true,
                        "revision": reported,
                        "changed": next_init && next_rev != since_rev,
                    }),
                )
            }
        }
        _ = tokio::time::sleep(Duration::from_millis(timeout_ms)) => {
            let (latest_rev, latest_init) = *rx.borrow_and_update();
            let reported = if latest_init { latest_rev } else { since_rev };
            BridgeHttpResponse::json(
                200,
                json!({
                    "ok": true,
                    "revision": reported,
                    "changed": latest_init && latest_rev > since_rev,
                }),
            )
        }
    }
}

async fn read_http_request(stream: &mut TcpStream) -> ReadRequestOutcome {
    let mut buf = Vec::with_capacity(1024);
    let mut temp = [0u8; 2048];

    let header_end = match timeout(HEADER_READ_TIMEOUT, async {
        loop {
            if let Some(pos) = find_header_end(&buf) {
                return Ok(Some(pos));
            }
            if buf.len() >= MAX_HEADER_BYTES {
                return Err(BridgeHttpResponse::error_json(
                    431,
                    "lan_room.http",
                    "ERR_LAN_HEADERS_TOO_LARGE",
                    "HTTP request headers exceed 8192 bytes",
                ));
            }
            let n = stream.read(&mut temp).await.map_err(|err| {
                BridgeHttpResponse::error_json(
                    400,
                    "lan_room.http",
                    "ERR_LAN_READ_FAILED",
                    &format!("Socket read error: {err}"),
                )
            })?;
            if n == 0 {
                if buf.is_empty() {
                    return Ok(None);
                }
                return Err(BridgeHttpResponse::error_json(
                    400,
                    "lan_room.http",
                    "ERR_LAN_INCOMPLETE_HEADERS",
                    "Client closed connection before completing HTTP headers",
                ));
            }
            buf.extend_from_slice(&temp[..n]);
        }
    })
    .await
    {
        Ok(Ok(Some(pos))) => pos,
        Ok(Ok(None)) => return ReadRequestOutcome::ClientClosedIdle,
        Ok(Err(resp)) => {
            return ReadRequestOutcome::ImmediateResponse {
                response: resp,
                drain_hint_bytes: 0,
            };
        }
        Err(_) => {
            if buf.is_empty() {
                return ReadRequestOutcome::ClientClosedIdle;
            }
            return ReadRequestOutcome::ImmediateResponse {
                response: BridgeHttpResponse::error_json(
                    408,
                    "lan_room.http",
                    "ERR_LAN_HEADER_TIMEOUT",
                    "Timed out reading HTTP headers",
                ),
                drain_hint_bytes: 0,
            };
        }
    };

    let header_text = String::from_utf8_lossy(&buf[..header_end]).into_owned();
    let mut lines = header_text.split("\r\n");
    let Some(request_line) = lines.next() else {
        return ReadRequestOutcome::ImmediateResponse {
            response: BridgeHttpResponse::error_json(
                400,
                "lan_room.http",
                "ERR_LAN_BAD_REQUEST_LINE",
                "Missing HTTP request line",
            ),
            drain_hint_bytes: 0,
        };
    };

    let mut parts = request_line.split_whitespace();
    let (Some(raw_method), Some(raw_target), Some(_http_ver)) =
        (parts.next(), parts.next(), parts.next())
    else {
        return ReadRequestOutcome::ImmediateResponse {
            response: BridgeHttpResponse::error_json(
                400,
                "lan_room.http",
                "ERR_LAN_BAD_REQUEST_LINE",
                "Malformed HTTP request line",
            ),
            drain_hint_bytes: 0,
        };
    };

    let method = raw_method.trim().to_ascii_uppercase();
    let (raw_path, raw_query) = match raw_target.split_once('?') {
        Some((p, q)) => (p, q),
        None => (raw_target, ""),
    };
    let decoded_path = percent_decode(raw_path, false);
    let path = if decoded_path.starts_with('/') {
        decoded_path
    } else {
        format!("/{decoded_path}")
    };
    let query = parse_query_map(raw_query);

    let mut headers = Map::new();
    let mut content_length: Option<usize> = None;
    let mut is_chunked = false;

    for line in lines {
        if line.is_empty() {
            continue;
        }
        let Some((name, val)) = line.split_once(':') else {
            continue;
        };
        let key = name.trim().to_ascii_lowercase();
        let value = val.trim().to_string();
        if key == "content-length" {
            match value.parse::<usize>() {
                Ok(len) => content_length = Some(len),
                Err(_) => {
                    return ReadRequestOutcome::ImmediateResponse {
                        response: BridgeHttpResponse::error_json(
                            400,
                            "lan_room.http",
                            "ERR_LAN_INVALID_CONTENT_LENGTH",
                            "Invalid Content-Length header",
                        ),
                        drain_hint_bytes: 0,
                    };
                }
            }
        } else if key == "transfer-encoding" && value.to_ascii_lowercase().contains("chunked") {
            is_chunked = true;
        }
        headers.insert(key, Value::String(value));
    }

    let body_prefix = &buf[header_end + 4..];

    if is_chunked {
        match timeout(BODY_READ_TIMEOUT, read_chunked_body(stream, body_prefix)).await {
            Ok(Ok(bytes)) => {
                return ReadRequestOutcome::Ready(ParsedHttpRequest {
                    method,
                    path,
                    query,
                    headers,
                    body_text: String::from_utf8_lossy(&bytes).into_owned(),
                });
            }
            Ok(Err(resp)) => {
                return ReadRequestOutcome::ImmediateResponse {
                    response: resp,
                    drain_hint_bytes: 4096,
                };
            }
            Err(_) => {
                return ReadRequestOutcome::ImmediateResponse {
                    response: BridgeHttpResponse::error_json(
                        408,
                        "lan_room.http",
                        "ERR_LAN_BODY_TIMEOUT",
                        "Timed out reading chunked request body",
                    ),
                    drain_hint_bytes: 0,
                };
            }
        }
    }

    let expected_len = content_length.unwrap_or(0);
    if expected_len > MAX_BODY_BYTES || body_prefix.len() > MAX_BODY_BYTES {
        let remaining = expected_len.saturating_sub(body_prefix.len());
        return ReadRequestOutcome::ImmediateResponse {
            response: BridgeHttpResponse::error_json(
                413,
                "lan_room.http",
                "ERR_LAN_BODY_TOO_LARGE",
                &format!("Request body exceeds maximum size of {MAX_BODY_BYTES} bytes"),
            ),
            drain_hint_bytes: remaining,
        };
    }

    let mut body_bytes = Vec::with_capacity(expected_len);
    let pre_copy = body_prefix.len().min(expected_len);
    body_bytes.extend_from_slice(&body_prefix[..pre_copy]);

    if body_bytes.len() < expected_len {
        let start = body_bytes.len();
        body_bytes.resize(expected_len, 0u8);
        match timeout(BODY_READ_TIMEOUT, stream.read_exact(&mut body_bytes[start..])).await {
            Ok(Ok(_)) => {}
            Ok(Err(err)) => {
                return ReadRequestOutcome::ImmediateResponse {
                    response: BridgeHttpResponse::error_json(
                        400,
                        "lan_room.http",
                        "ERR_LAN_INCOMPLETE_BODY",
                        &format!("Failed reading HTTP request body: {err}"),
                    ),
                    drain_hint_bytes: 0,
                };
            }
            Err(_) => {
                return ReadRequestOutcome::ImmediateResponse {
                    response: BridgeHttpResponse::error_json(
                        408,
                        "lan_room.http",
                        "ERR_LAN_BODY_TIMEOUT",
                        "Timed out reading HTTP request body",
                    ),
                    drain_hint_bytes: 0,
                };
            }
        }
    }

    ReadRequestOutcome::Ready(ParsedHttpRequest {
        method,
        path,
        query,
        headers,
        body_text: String::from_utf8_lossy(&body_bytes).into_owned(),
    })
}

async fn read_chunked_body(
    stream: &mut TcpStream,
    initial: &[u8],
) -> Result<Vec<u8>, BridgeHttpResponse> {
    let mut raw = initial.to_vec();
    let mut decoded = Vec::new();
    let mut cursor = 0usize;
    let mut scratch = [0u8; 2048];

    loop {
        let line_end = loop {
            if let Some(rel) = raw[cursor..].windows(2).position(|w| w == b"\r\n") {
                break cursor + rel;
            }
            if raw.len() - cursor > 128 {
                return Err(BridgeHttpResponse::error_json(
                    400,
                    "lan_room.http",
                    "ERR_LAN_INVALID_CHUNK",
                    "Malformed chunk header",
                ));
            }
            let n = stream.read(&mut scratch).await.map_err(|err| {
                BridgeHttpResponse::error_json(
                    400,
                    "lan_room.http",
                    "ERR_LAN_READ_FAILED",
                    &format!("Chunk read failed: {err}"),
                )
            })?;
            if n == 0 {
                return Err(BridgeHttpResponse::error_json(
                    400,
                    "lan_room.http",
                    "ERR_LAN_INCOMPLETE_BODY",
                    "Unexpected EOF in chunked body",
                ));
            }
            raw.extend_from_slice(&scratch[..n]);
        };

        let size_str = String::from_utf8_lossy(&raw[cursor..line_end]);
        let hex_part = size_str.split(';').next().unwrap_or("").trim();
        let chunk_size = usize::from_str_radix(hex_part, 16).map_err(|_| {
            BridgeHttpResponse::error_json(
                400,
                "lan_room.http",
                "ERR_LAN_INVALID_CHUNK",
                "Invalid hex chunk length",
            )
        })?;
        cursor = line_end + 2;

        if chunk_size == 0 {
            return Ok(decoded);
        }
        if decoded.len().saturating_add(chunk_size) > MAX_BODY_BYTES {
            return Err(BridgeHttpResponse::error_json(
                413,
                "lan_room.http",
                "ERR_LAN_BODY_TOO_LARGE",
                &format!("Chunked body exceeds maximum size of {MAX_BODY_BYTES} bytes"),
            ));
        }

        while raw.len() < cursor + chunk_size + 2 {
            let n = stream.read(&mut scratch).await.map_err(|err| {
                BridgeHttpResponse::error_json(
                    400,
                    "lan_room.http",
                    "ERR_LAN_READ_FAILED",
                    &format!("Chunk payload read failed: {err}"),
                )
            })?;
            if n == 0 {
                return Err(BridgeHttpResponse::error_json(
                    400,
                    "lan_room.http",
                    "ERR_LAN_INCOMPLETE_BODY",
                    "Unexpected EOF reading chunk payload",
                ));
            }
            raw.extend_from_slice(&scratch[..n]);
        }

        decoded.extend_from_slice(&raw[cursor..cursor + chunk_size]);
        cursor += chunk_size + 2;
        if cursor > 4096 {
            raw.drain(..cursor);
            cursor = 0;
        }
    }
}

async fn drain_excess_body(stream: &mut TcpStream, mut max_bytes: usize) {
    let mut discard = [0u8; 4096];
    let _ = timeout(Duration::from_millis(150), async {
        while max_bytes > 0 {
            let cap = discard.len().min(max_bytes);
            match stream.read(&mut discard[..cap]).await {
                Ok(0) | Err(_) => break,
                Ok(n) => max_bytes = max_bytes.saturating_sub(n),
            }
        }
    })
    .await;
}

async fn write_http_response(
    stream: &mut TcpStream,
    resp: &BridgeHttpResponse,
) -> std::io::Result<()> {
    let reason = status_reason_phrase(resp.status);
    let header = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nCache-Control: {}\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type, Authorization, X-Seat-Token\r\nConnection: close\r\n\r\n",
        resp.status,
        reason,
        resp.content_type,
        resp.cache_control,
        resp.body.len(),
    );
    stream.write_all(header.as_bytes()).await?;
    if !resp.body.is_empty() {
        stream.write_all(&resp.body).await?;
    }
    stream.flush().await?;
    let _ = stream.shutdown().await;
    Ok(())
}

fn find_header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

fn sanitize_header_value(raw: &str, default_val: &str) -> String {
    let cleaned: String = raw
        .chars()
        .filter(|&c| c != '\r' && c != '\n' && c != '\0')
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        default_val.to_string()
    } else {
        trimmed.to_string()
    }
}

fn status_reason_phrase(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        408 => "Request Timeout",
        413 => "Payload Too Large",
        429 => "Too Many Requests",
        431 => "Request Header Fields Too Large",
        500 => "Internal Server Error",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "Response",
    }
}

fn parse_query_map(raw_query: &str) -> Map<String, Value> {
    let mut map = Map::new();
    for pair in raw_query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (k, v) = match pair.split_once('=') {
            Some((k, v)) => (k, v),
            None => (pair, ""),
        };
        let key = percent_decode(k, true);
        if !key.is_empty() {
            map.insert(key, Value::String(percent_decode(v, true)));
        }
    }
    map
}

fn percent_decode(input: &str, plus_as_space: bool) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0usize;
    while i < bytes.len() {
        let b = bytes[i];
        if plus_as_space && b == b'+' {
            out.push(b' ');
            i += 1;
        } else if b == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2])) {
                out.push((hi << 4) | lo);
                i += 3;
            } else {
                out.push(b);
                i += 1;
            }
        } else {
            out.push(b);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn is_usable_lan_ipv4(ip: Ipv4Addr) -> bool {
    !ip.is_loopback() && !ip.is_unspecified() && !ip.is_link_local() && !ip.is_multicast()
}

#[cfg(any(target_os = "ios", target_os = "android"))]
fn score_interface_ipv4(name: &str, ip: Ipv4Addr) -> Option<u32> {
    if !is_usable_lan_ipv4(ip) {
        return None;
    }
    let lower = name.to_ascii_lowercase();
    let ignored_prefixes = [
        "lo", "utun", "ipsec", "ppp", "tun", "tap", "pdp_ip", "rmnet", "ccmni", "llw", "awdl",
        "anpi", "clat", "dummy",
    ];
    if ignored_prefixes.iter().any(|p| lower.starts_with(p)) {
        return None;
    }
    let base_score = if lower == "bridge100"
        || lower.starts_with("bridge")
        || lower == "ap0"
        || lower == "wlan1"
        || lower.starts_with("softap")
        || lower.starts_with("swlan")
    {
        100
    } else if lower == "en0" || lower == "wlan0" {
        90
    } else if lower.starts_with("en") || lower.starts_with("wlan") || lower.starts_with("eth") {
        70
    } else {
        40
    };
    let private_bonus = if ip.is_private() { 5 } else { 0 };
    Some(base_score + private_bonus)
}

#[cfg(any(target_os = "ios", target_os = "android"))]
fn detect_ifaddrs_ipv4() -> Option<Ipv4Addr> {
    use std::ffi::CStr;
    let mut ifap: *mut libc::ifaddrs = std::ptr::null_mut();
    if unsafe { libc::getifaddrs(&mut ifap) } != 0 || ifap.is_null() {
        return None;
    }
    let mut best: Option<(u32, Ipv4Addr)> = None;
    let mut cur = ifap;
    while !cur.is_null() {
        let ifa = unsafe { &*cur };
        cur = ifa.ifa_next;
        let flags = ifa.ifa_flags as u32;
        if (flags & (libc::IFF_UP as u32)) == 0 || (flags & (libc::IFF_LOOPBACK as u32)) != 0 {
            continue;
        }
        if ifa.ifa_addr.is_null() || ifa.ifa_name.is_null() {
            continue;
        }
        let family = unsafe { (*ifa.ifa_addr).sa_family as i32 };
        if family != libc::AF_INET {
            continue;
        }
        let sin = unsafe { &*(ifa.ifa_addr as *const libc::sockaddr_in) };
        let ip = Ipv4Addr::from(sin.sin_addr.s_addr.to_ne_bytes());
        let name = unsafe { CStr::from_ptr(ifa.ifa_name) }.to_string_lossy();
        if let Some(score) = score_interface_ipv4(&name, ip)
            && best.is_none_or(|(best_score, _)| score > best_score)
        {
            best = Some((score, ip));
        }
    }
    unsafe {
        libc::freeifaddrs(ifap);
    }
    best.map(|(_, ip)| ip)
}

fn detect_udp_route_ipv4() -> Option<Ipv4Addr> {
    let sock = UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("192.0.2.1:80").ok()?;
    match sock.local_addr().ok()? {
        SocketAddr::V4(v4) if is_usable_lan_ipv4(*v4.ip()) => Some(*v4.ip()),
        _ => None,
    }
}

pub(crate) fn detect_lan_ipv4() -> String {
    #[cfg(any(target_os = "ios", target_os = "android"))]
    if let Some(ip) = detect_ifaddrs_ipv4() {
        return ip.to_string();
    }
    if let Some(ip) = detect_udp_route_ipv4() {
        return ip.to_string();
    }
    "127.0.0.1".to_string()
}

pub(crate) struct HostInner {
    foreground: AtomicBool,
    epoch: AtomicU64,
    rooms: Mutex<HashMap<String, Arc<RoomSession>>>,
}

impl HostInner {
    fn new() -> Self {
        Self {
            foreground: AtomicBool::new(true),
            epoch: AtomicU64::new(0),
            rooms: Mutex::new(HashMap::new()),
        }
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) async fn open_room(&self, requested_id: String) -> Result<NativeLanRoomInfo, String> {
        self.open_room_with_port(requested_id, None).await
    }

    pub(crate) async fn open_room_with_port(
        &self,
        requested_id: String,
        preferred_port: Option<u32>,
    ) -> Result<NativeLanRoomInfo, String> {
        let epoch_before = self.epoch.load(Ordering::Acquire);
        if !self.foreground.load(Ordering::Acquire) {
            return Err(
                "[stage=lan_room.open code=ERR_LAN_ROOM_BACKGROUNDED] Cannot open LAN companion room while app is in background"
                    .to_string(),
            );
        }

        let requested = (!requested_id.trim().is_empty()).then_some(requested_id);
        let preferred_u16 = preferred_port.and_then(|p| u16::try_from(p).ok()).filter(|p| *p > 0);
        let session = RoomSession::bind(requested.as_deref(), preferred_u16).await?;

        if !self.foreground.load(Ordering::Acquire) || self.epoch.load(Ordering::Acquire) != epoch_before {
            session.close(true);
            return Err(
                "[stage=lan_room.open code=ERR_LAN_ROOM_BACKGROUNDED] App entered background while binding LAN room"
                    .to_string(),
            );
        }

        let info = session.info();
        if let Some(prev) = self
            .rooms
            .lock()
            .unwrap()
            .insert(session.id.clone(), session)
        {
            prev.close(false);
        }
        Ok(info)
    }

    pub(crate) fn lookup(&self, room_id: &str) -> Option<Arc<RoomSession>> {
        self.rooms.lock().unwrap().get(room_id).cloned()
    }

    pub(crate) fn close_room(&self, room_id: &str) {
        if let Some(room) = self.rooms.lock().unwrap().remove(room_id) {
            room.close(false);
        }
    }

    pub(crate) fn set_foreground(&self, active: bool) {
        self.foreground.store(active, Ordering::Release);
        if !active {
            self.epoch.fetch_add(1, Ordering::AcqRel);
            let drained: Vec<_> = self.rooms.lock().unwrap().drain().map(|(_, r)| r).collect();
            for room in drained {
                room.close(true);
            }
        }
    }

    pub(crate) fn stop_all(&self) {
        let drained: Vec<_> = self.rooms.lock().unwrap().drain().map(|(_, r)| r).collect();
        for room in drained {
            room.close(false);
        }
    }
}

/// App-owned local Wi-Fi HTTP server host for multi-player tabletop companion web views.
#[class]
pub struct LanRoomHost {
    inner: Arc<HostInner>,
}

#[class]
impl LanRoomHost {
    /// Construct an idle `LanRoomHost` without binding any network sockets.
    pub fn new() -> Self {
        Self {
            inner: Arc::new(HostInner::new()),
        }
    }

    /// Bind the requested `preferred_port` when available or fall back to an ephemeral port (`0.0.0.0:0`).
    pub async fn open_room(
        this: Instance<Self>,
        requested_id: String,
        preferred_port: Option<u32>,
    ) -> Result<NativeLanRoomInfo, String> {
        let inner = this.with(|s| s.inner.clone());
        background(async move { inner.open_room_with_port(requested_id, preferred_port).await })
            .await
            .map_err(|_| {
                "[stage=lan_room.open code=ERR_LAN_ROOM_OPEN_CANCELLED] LAN room open task cancelled"
                    .to_string()
            })?
    }

    /// Await the next non-wait HTTP request (`GET` / `POST`) arriving on `room_id`.
    pub async fn next_request(
        this: Instance<Self>,
        room_id: String,
    ) -> Result<NativeLanHttpRequest, String> {
        let session = {
            let inner = this.with(|s| s.inner.clone());
            inner.lookup(&room_id).ok_or_else(|| {
                format!(
                    "[stage=lan_room.nextRequest code=ERR_LAN_ROOM_MISSING] Unknown LAN room \"{room_id}\""
                )
            })?
        };
        background(async move { session.next_request().await })
            .await
            .map_err(|_| {
                "[stage=lan_room.nextRequest code=ERR_LAN_ROOM_WAIT_CANCELLED] LAN request pump cancelled"
                    .to_string()
            })?
    }

    /// Fulfill an in-flight HTTP request previously yielded by `nextRequest`.
    pub fn respond_request(
        &self,
        room_id: String,
        request_id: String,
        status: i32,
        content_type: String,
        cache_control: String,
        body: String,
    ) {
        if let Some(room) = self.inner.lookup(&room_id) {
            room.respond_request(&request_id, status, content_type, cache_control, body);
        }
    }

    /// Broadcast a state revision bump, immediately waking all parked `/api/wait?sinceRev=` connections.
    pub fn notify_revision(&self, room_id: String, revision: f64) {
        if let Some(room) = self.inner.lookup(&room_id) {
            let rev = if revision.is_finite() && revision >= 0.0 {
                revision as u64
            } else {
                0
            };
            room.notify_revision(rev);
        }
    }

    /// Re-probe active LAN/hotspot IPv4 interfaces and return the updated `baseUrl`.
    pub fn refresh_addresses(&self, room_id: String) -> Result<NativeLanRoomInfo, String> {
        let room = self.inner.lookup(&room_id).ok_or_else(|| {
            format!(
                "[stage=lan_room.refreshAddresses code=ERR_LAN_ROOM_MISSING] Unknown LAN room \"{room_id}\""
            )
        })?;
        Ok(room.info())
    }

    /// Close a specific LAN room socket and abort all active client connections immediately.
    pub fn close_room(&self, room_id: String) {
        self.inner.close_room(&room_id);
    }

    /// Synchronize app foreground/background state; backgrounding immediately closes all active LAN rooms.
    pub fn set_foreground(&self, active: bool) {
        self.inner.set_foreground(active);
    }

    /// Force-close all active LAN rooms owned by this host.
    pub fn stop_all(&self) {
        self.inner.stop_all();
    }
}

impl Drop for LanRoomHost {
    fn drop(&mut self) {
        self.inner.stop_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    fn local_url(port: u32, path: &str) -> String {
        format!("http://127.0.0.1:{port}{path}")
    }

    #[tokio::test]
    async fn binds_and_handles_concurrent_get_and_post_requests() {
        let host = Arc::new(HostInner::new());
        let info = host.open_room("room-http-1".to_string()).await.unwrap();
        assert_eq!(info.room_id, "room-http-1");
        assert!(info.port > 0);
        assert!(info.base_url.starts_with("http://"));

        let pump_host = host.clone();
        let pump = tokio::spawn(async move {
            for _ in 0..4 {
                let room = pump_host.lookup("room-http-1").unwrap();
                let req = room.next_request().await.unwrap();
                let room_for_reply = pump_host.lookup("room-http-1").unwrap();
                if req.method == "GET" && req.path == "/" {
                    room_for_reply.respond_request(
                        &req.request_id,
                        200,
                        "text/html; charset=utf-8".to_string(),
                        "no-store".to_string(),
                        "<!doctype html><title>LOOI</title>".to_string(),
                    );
                } else if req.method == "POST" && req.path == "/api/action" {
                    let parsed_query: Value = serde_json::from_str(&req.query_json).unwrap();
                    let body: Value = serde_json::from_str(&req.body_text).unwrap();
                    room_for_reply.respond_request(
                        &req.request_id,
                        200,
                        "application/json; charset=utf-8".to_string(),
                        "no-store".to_string(),
                        json!({
                            "ok": true,
                            "seat": body["seat"],
                            "mode": parsed_query["mode"],
                        })
                        .to_string(),
                    );
                }
            }
        });

        let client = reqwest::Client::new();
        let port = info.port;

        let (r1, r2, r3, r4) = tokio::join!(
            client.get(local_url(port, "/")).send(),
            client
                .post(local_url(port, "/api/action?mode=fast+track"))
                .json(&json!({"seat": 3, "action": "seer_check"}))
                .send(),
            client
                .post(local_url(port, "/api/action?mode=night"))
                .json(&json!({"seat": 7, "action": "guard_pick"}))
                .send(),
            client.get(local_url(port, "/")).send(),
        );

        let html = r1.unwrap().text().await.unwrap();
        assert!(html.contains("<title>LOOI</title>"));
        let j2: Value = r2.unwrap().json().await.unwrap();
        assert_eq!(j2["ok"], true);
        assert_eq!(j2["seat"], 3);
        assert_eq!(j2["mode"], "fast track");
        let j3: Value = r3.unwrap().json().await.unwrap();
        assert_eq!(j3["seat"], 7);
        assert_eq!(j3["mode"], "night");
        assert_eq!(r4.unwrap().status(), 200);

        pump.await.unwrap();
        host.close_room("room-http-1");
    }

    #[tokio::test]
    async fn wait_endpoint_blocks_until_notify_revision_wakes_multiple_clients_instantly() {
        let host = Arc::new(HostInner::new());
        let info = host.open_room("room-wait-1".to_string()).await.unwrap();
        let room = host.lookup("room-wait-1").unwrap();
        room.notify_revision(4);

        let client = reqwest::Client::new();

        // Already ahead of sinceRev=2 -> returns immediately without waiting
        let t0 = Instant::now();
        let immediate: Value = client
            .get(local_url(info.port, "/api/wait?sinceRev=2&timeoutMs=5000"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(immediate["revision"], 4);
        assert_eq!(immediate["changed"], true);
        assert!(t0.elapsed() < Duration::from_millis(200));

        // Park 3 concurrent long-poll clients at sinceRev=4, then bump revision to 5 after 60ms
        let bump_room = room.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(60)).await;
            bump_room.notify_revision(5);
        });

        let started = Instant::now();
        let (w1, w2, w3) = tokio::join!(
            client
                .get(local_url(info.port, "/api/wait?sinceRev=4&timeoutMs=15000"))
                .send(),
            client
                .get(local_url(info.port, "/api/wait?sinceRev=4&timeoutMs=15000"))
                .send(),
            client
                .get(local_url(info.port, "/api/wait?sinceRev=4&timeoutMs=15000"))
                .send(),
        );
        let elapsed = started.elapsed();
        assert!(
            elapsed >= Duration::from_millis(45) && elapsed < Duration::from_millis(500),
            "expected wakeup right after 60ms notify_revision, took {elapsed:?}"
        );

        for resp in [w1, w2, w3] {
            let body: Value = resp.unwrap().json().await.unwrap();
            assert_eq!(body["revision"], 5);
            assert_eq!(body["changed"], true);
        }

        host.close_room("room-wait-1");
    }

    #[tokio::test]
    async fn rejects_request_body_exceeding_16_kib_with_413() {
        let host = Arc::new(HostInner::new());
        let info = host.open_room("room-cap-1".to_string()).await.unwrap();
        let client = reqwest::Client::new();

        let oversized = "x".repeat(MAX_BODY_BYTES + 2048);
        let resp = client
            .post(local_url(info.port, "/api/action"))
            .header("content-type", "application/json")
            .body(oversized)
            .send()
            .await
            .unwrap();

        assert_eq!(resp.status(), 413);
        let payload: Value = resp.json().await.unwrap();
        assert_eq!(payload["code"], "ERR_LAN_BODY_TOO_LARGE");

        host.close_room("room-cap-1");
    }

    #[tokio::test]
    async fn background_and_close_immediately_teardown_listener_and_parked_waiters() {
        let host = Arc::new(HostInner::new());
        let info = host.open_room("room-bg-1".to_string()).await.unwrap();
        let room = host.lookup("room-bg-1").unwrap();
        room.notify_revision(1);

        let next_req_task = {
            let room_clone = room.clone();
            tokio::spawn(async move { room_clone.next_request().await })
        };

        let client = reqwest::Client::new();
        let wait_http_task = {
            let url = local_url(info.port, "/api/wait?sinceRev=1&timeoutMs=20000");
            tokio::spawn(async move { client.get(url).send().await })
        };

        tokio::time::sleep(Duration::from_millis(50)).await;
        let close_started = Instant::now();
        host.set_foreground(false);

        let next_err = next_req_task.await.unwrap().unwrap_err();
        assert!(
            next_err.contains("ERR_LAN_ROOM_BACKGROUNDED"),
            "unexpected error: {next_err}"
        );

        // Parked /api/wait connection must finish immediately rather than waiting 20s
        let wait_res = wait_http_task.await.unwrap();
        assert!(close_started.elapsed() < Duration::from_millis(500));
        if let Ok(resp) = wait_res {
            assert_eq!(resp.status(), 503);
        }

        // Cannot open new rooms while in background
        let bg_open_err = host.open_room("room-bg-2".to_string()).await.unwrap_err();
        assert!(bg_open_err.contains("ERR_LAN_ROOM_BACKGROUNDED"));

        // Listener port is closed; new TCP connect fails or resets immediately
        assert!(TcpStream::connect(("127.0.0.1", info.port as u16)).await.is_err());

        host.set_foreground(true);
        let reopened = host.open_room("room-bg-3".to_string()).await.unwrap();
        assert!(reopened.port > 0);
        host.stop_all();
    }

    #[tokio::test]
    async fn preferred_port_rebinds_same_port_and_falls_back_when_occupied() {
        let host = Arc::new(HostInner::new());
        let first = host.open_room("room-pref-1".to_string()).await.unwrap();
        let saved_port = first.port;
        assert!(saved_port > 0);

        host.close_room("room-pref-1");
        tokio::time::sleep(Duration::from_millis(30)).await;

        // Reopen with same roomId and preferred_port while the port is free -> reuses exact port
        let rebound = host
            .open_room_with_port("room-pref-1".to_string(), Some(saved_port))
            .await
            .unwrap();
        assert_eq!(rebound.room_id, "room-pref-1");
        assert_eq!(rebound.port, saved_port);

        // Hold another room on `saved_port`; requesting `saved_port` falls back cleanly to a fresh port
        let fallback = host
            .open_room_with_port("room-pref-2".to_string(), Some(saved_port))
            .await
            .unwrap();
        assert_eq!(fallback.room_id, "room-pref-2");
        assert_ne!(fallback.port, saved_port);
        assert!(fallback.port > 0);

        host.stop_all();
    }
}
