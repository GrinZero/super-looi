//! CS2 TCP transport, with the mandatory UDP LAN negotiation.
//! Adapted from Xiaomi Camera Native / go2rtc (MIT; native/licenses/xiaomi-camera).
use super::{cloud::Provision, crypto, playback::StartFailure, video::VideoPacket};
use serde_json::json;
use std::{
    collections::HashMap,
    net::{Ipv4Addr, SocketAddr},
    sync::{
        Arc,
        atomic::{AtomicU16, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpStream, UdpSocket},
    sync::{mpsc, oneshot},
    task::JoinHandle,
    time::{Instant, timeout, timeout_at},
};
pub(super) const LIMIT: usize = 8 * 1024 * 1024;
pub(super) type Incoming = Result<(u8, Vec<u8>), String>;
pub(super) type Outgoing = (Vec<u8>, Option<oneshot::Sender<Result<(), String>>>);
pub(super) fn message(kind: u8, data: &[u8]) -> Vec<u8> {
    let mut out = vec![0xf1, kind];
    out.extend((data.len() as u16).to_be_bytes());
    out.extend(data);
    out
}
async fn exchange(
    socket: &UdpSocket,
    remote: &mut SocketAddr,
    packet: &[u8],
    kinds: &[u8],
    deadline: Instant,
    stage: &str,
) -> Result<Vec<u8>, String> {
    let mut buffer = [0; 65535];
    while Instant::now() < deadline {
        timeout_at(deadline, socket.send_to(packet, *remote))
            .await
            .map_err(|_| {
                format!(
                    "[stage={stage} code=camera_discovery_send_timeout] UDP send deadline elapsed"
                )
            })?
            .map_err(|error| format!("[stage={stage} code=camera_discovery_send] {error}"))?;
        let attempt = (Instant::now() + Duration::from_secs(1)).min(deadline);
        while Instant::now() < attempt {
            let Ok(result) = timeout(attempt - Instant::now(), socket.recv_from(&mut buffer)).await
            else {
                break;
            };
            let (length, address) = result.map_err(|error| {
                format!("[stage={stage} code=camera_discovery_receive] {error}")
            })?;
            if address.ip() == remote.ip()
                && length >= 16
                && buffer[0] == 0xf1
                && kinds.contains(&buffer[1])
                && u16::from_be_bytes([buffer[2], buffer[3]]) as usize + 4 == length
            {
                *remote = address;
                return Ok(buffer[..length].to_vec());
            }
        }
    }
    Err(format!(
        "[stage={stage} code=camera_cs2_handshake_timeout] no expected UDP reply"
    ))
}
async fn send_packet(sender: &mpsc::Sender<Outgoing>, bytes: Vec<u8>) -> Result<(), String> {
    let (receipt, result) = oneshot::channel();
    sender
        .send((bytes, Some(receipt)))
        .await
        .map_err(|_| "camera_connection_ended")?;
    result.await.map_err(|_| "camera_connection_ended")?
}
struct Connection {
    sender: mpsc::Sender<Outgoing>,
    receiver: mpsc::Receiver<Incoming>,
    reader: JoinHandle<()>,
    writer: Option<JoinHandle<()>>,
    sequence: Arc<AtomicU16>,
}

#[derive(Clone)]
pub struct CommandHandle {
    sender: mpsc::Sender<Outgoing>,
    sequence: Arc<AtomicU16>,
    key: [u8; 32],
}

impl CommandHandle {
    async fn send_raw(&self, command: u32, payload: &[u8]) -> Result<(), String> {
        let seq = self.sequence.fetch_add(1, Ordering::Relaxed);
        let mut data = vec![0xd1, 0];
        data.extend(seq.to_be_bytes());
        data.extend((payload.len() as u32 + 4).to_be_bytes());
        data.extend(command.to_be_bytes());
        data.extend(payload);
        send_packet(&self.sender, message(0xd0, &data)).await
    }

    pub async fn pan_tilt(&self, direction: &str) -> Result<(), String> {
        let operation = match direction {
            "left" => 1,
            "right" => 2,
            "up" => 3,
            "down" => 4,
            _ => return Err("camera_ptz_direction_invalid".into()),
        };
        let mut request = 0x112u32.to_be_bytes().to_vec();
        request.extend(json!({ "operation": operation }).to_string().as_bytes());
        self.send_raw(0x1001, &crypto::encrypt_media(&self.key, &request))
            .await
    }
}
impl Connection {
    async fn connect_relay(parameters: &super::relay::Parameters) -> Result<Self, String> {
        let peer = super::relay::Peer::connect(parameters).await?;
        let (sender, commands) = mpsc::channel::<Outgoing>(8);
        let (incoming, receiver) = mpsc::channel::<Incoming>(16);
        let reader = tokio::spawn(peer.run(commands, incoming));
        Ok(Self {
            sender,
            receiver,
            reader,
            writer: None,
            sequence: Arc::new(AtomicU16::new(0)),
        })
    }

    async fn connect_lan(host: &str, deadline: Instant) -> Result<Self, String> {
        let ip: Ipv4Addr = host.parse().map_err(|_| "[stage=camera.lan.address code=camera_lan_ip_missing] device has no usable IPv4 address")?;
        if ip.is_unspecified() {
            return Err("[stage=camera.lan.address code=camera_lan_ip_missing] device has no usable IPv4 address".into());
        }
        let mut remote = SocketAddr::from((ip, 32108));
        let socket = UdpSocket::bind("0.0.0.0:0").await.map_err(|error| {
            format!("[stage=camera.lan.discovery code=camera_discovery_socket] {error}")
        })?;
        let punch = exchange(
            &socket,
            &mut remote,
            &message(0x30, &[]),
            &[0x41],
            deadline,
            "camera.lan.discovery",
        )
        .await?;
        let ready = exchange(
            &socket,
            &mut remote,
            &punch,
            &[0x42, 0x43],
            deadline,
            "camera.lan.handshake",
        )
        .await?;
        if ready[1] != 0x43 {
            return Err("[stage=camera.lan.handshake code=camera_cs2_tcp_unavailable] camera negotiated UDP".into());
        }
        drop(socket);
        let stream = timeout_at(deadline, TcpStream::connect(remote))
            .await
            .map_err(
                |_| "[stage=camera.lan.tcp code=camera_tcp_timeout] TCP connect deadline elapsed",
            )?
            .map_err(|error| format!("[stage=camera.lan.tcp code=camera_tcp_connect] {error}"))?;
        stream
            .set_nodelay(true)
            .map_err(|error| format!("[stage=camera.lan.tcp code=camera_tcp_configure] {error}"))?;
        let (mut read, mut write) = stream.into_split();
        let (sender, mut commands) = mpsc::channel::<Outgoing>(8);
        let (incoming, receiver) = mpsc::channel::<Incoming>(16);
        let replies = sender.clone();
        let reader = tokio::spawn(async move {
            let mut channels: HashMap<u8, Vec<u8>> = HashMap::new();
            let result: Result<(), String> = async {
                loop {
                    let mut header = [0; 8];
                    timeout(Duration::from_secs(15), read.read_exact(&mut header))
                        .await
                        .map_err(|_| "camera_media_timeout")?
                        .map_err(|error| format!("[stage=camera.lan.read_header code=camera_connection_ended] {error}"))?;
                    let size = u16::from_be_bytes([header[0], header[1]]) as usize;
                    if header[2] != 0x68 || size < 4 {
                        return Err("camera_tcp_frame_invalid".into());
                    }
                    let mut packet = vec![0; size];
                    read.read_exact(&mut packet)
                        .await
                        .map_err(|error| format!("[stage=camera.lan.read_payload code=camera_connection_ended] {error}"))?;
                    if packet[0] != 0xf1
                        || u16::from_be_bytes([packet[2], packet[3]]) as usize + 4 != size
                    {
                        return Err("camera_cs2_packet_invalid".into());
                    }
                    match packet[1] {
                        0xd0 => {
                            if size < 8 || packet[4] != 0xd1 {
                                return Err("camera_cs2_channel_invalid".into());
                            }
                            let channel = packet[5];
                            if channel != 0 && channel != 2 {
                                continue;
                            }
                            let buffer = channels.entry(channel).or_default();
                            buffer.extend_from_slice(&packet[8..]);
                            if buffer.len() > LIMIT + 4 {
                                return Err("camera_packet_too_large".into());
                            }
                            while buffer.len() >= 4 {
                                let length =
                                    u32::from_be_bytes(buffer[..4].try_into().unwrap()) as usize;
                                if length == 0 || length > LIMIT {
                                    return Err("camera_packet_length_invalid".into());
                                }
                                if buffer.len() < length + 4 {
                                    break;
                                }
                                let data = buffer[4..length + 4].to_vec();
                                buffer.drain(..length + 4);
                                incoming
                                    .send(Ok((channel, data)))
                                    .await
                                    .map_err(|_| "camera_session_closed")?;
                            }
                        }
                        0xe0 => {
                            let _ = replies.send((message(0xe1, &[]), None)).await;
                        }
                        0xf0 => {
                            let _ = replies.send((message(0xf1, &[]), None)).await;
                            return Err("camera_peer_closed".into());
                        }
                        _ => {}
                    }
                }
            }
            .await;
            if let Err(error) = result {
                let _ = incoming.send(Err(error)).await;
            }
        });
        let writer = tokio::spawn(async move {
            let mut keepalive = tokio::time::interval(Duration::from_secs(1));
            loop {
                let (packet, receipt) = tokio::select! {
                    command=commands.recv() => match command { Some(command)=>command,None=>break },
                    _=keepalive.tick() => (message(0xe0,&[]),None),
                };
                let mut frame = Vec::with_capacity(packet.len() + 8);
                frame.extend((packet.len() as u16).to_be_bytes());
                frame.extend([0x68, 0, 0, 0, 0, 0]);
                frame.extend(packet);
                let result = timeout(Duration::from_secs(5), write.write_all(&frame))
                    .await
                    .map_err(|_| "camera_send_timeout".to_owned())
                    .and_then(|r| {
                        r.map_err(|error| {
                            format!("[stage=camera.lan.write code=camera_send_failed] {error}")
                        })
                    });
                let failed = result.is_err();
                if let Some(receipt) = receipt {
                    let _ = receipt.send(result);
                }
                if failed {
                    break;
                }
            }
        });
        Ok(Self {
            sender,
            receiver,
            reader,
            writer: Some(writer),
            sequence: Arc::new(AtomicU16::new(0)),
        })
    }
    async fn command(&self, command: u32, payload: &[u8]) -> Result<(), String> {
        let seq = self.sequence.fetch_add(1, Ordering::Relaxed);
        let mut data = vec![0xd1, 0];
        data.extend(seq.to_be_bytes());
        data.extend((payload.len() as u32 + 4).to_be_bytes());
        data.extend(command.to_be_bytes());
        data.extend(payload);
        send_packet(&self.sender, message(0xd0, &data)).await
    }
    async fn receive(&mut self) -> Result<(u8, Vec<u8>), String> {
        self.receiver
            .recv()
            .await
            .ok_or("camera_connection_ended".to_owned())?
    }
}
impl Drop for Connection {
    fn drop(&mut self) {
        self.reader.abort();
        if let Some(writer) = &self.writer {
            writer.abort();
        }
    }
}
pub struct Miss {
    connection: Connection,
    key: [u8; 32],
    route: &'static str,
}
impl Miss {
    pub async fn connect_lan(
        host: &str,
        provision: &Provision,
        model: &str,
        start_video: bool,
        connection_timeout: Duration,
    ) -> Result<Self, StartFailure> {
        let deadline = Instant::now() + connection_timeout;
        let connection = Connection::connect_lan(host, deadline)
            .await
            .map_err(StartFailure::Transport)?;
        Self::start(connection, provision, model, start_video, deadline, "lan").await
    }

    pub async fn connect_relay(provision: &Provision, model: &str) -> Result<Self, String> {
        let parameters = provision.relay.as_ref().map_err(Clone::clone)?;
        let connection = Connection::connect_relay(parameters).await?;
        let deadline = Instant::now() + Duration::from_secs(8);
        Self::start(connection, provision, model, true, deadline, "relay")
            .await
            .map_err(StartFailure::reason)
    }

    async fn start(
        mut connection: Connection,
        provision: &Provision,
        model: &str,
        start_video: bool,
        deadline: Instant,
        route: &'static str,
    ) -> Result<Self, StartFailure> {
        let (uuid, support_encrypt) = if route == "relay" {
            (uuid::Uuid::new_v4().to_string(), 15)
        } else {
            (String::new(), 0)
        };
        let auth = json!({"public_key":crypto::hex(&provision.public),"sign":provision.sign,"uuid":uuid,"support_encrypt":support_encrypt});
        let response = timeout_at(deadline, async {
            connection.command(0x100, auth.to_string().as_bytes()).await?;
            loop {
                let (channel, response) = connection.receive().await?;
                if channel == 0 && is_reply(&response, 0x101) {
                    return Ok::<_, String>(response);
                }
            }
        })
        .await
        .map_err(|_| StartFailure::Transport(format!(
            "[stage=camera.{route}.miss_auth code=camera_auth_timeout] no MISS authentication response before deadline"
        )))?
        .map_err(|error| StartFailure::Transport(format!("[stage=camera.{route}.miss_auth] {error}")))?;
        let invalid_response = || {
            StartFailure::Terminal(format!(
                "[stage=camera.{route}.miss_auth code=camera_auth_response_invalid] invalid MISS authentication response"
            ))
        };
        let auth: serde_json::Value =
            serde_json::from_slice(response.get(4..).ok_or_else(invalid_response)?)
                .map_err(|_| invalid_response())?;
        if auth["result"] != "success" {
            let reason = if let Some(code) = auth["code"].as_i64() {
                format!("camera returned code {code}")
            } else {
                "camera rejected MISS authentication".into()
            };
            return Err(StartFailure::Terminal(format!(
                "[stage=camera.{route}.miss_auth code=camera_auth_rejected] {reason}"
            )));
        }

        if start_video {
            let quality = if ["chuangmi.camera.046c04", "chuangmi.camera.72ac1"].contains(&model) {
                3
            } else {
                2
            };
            let mut request = 0x102u32.to_be_bytes().to_vec();
            request.extend(
                json!({"videoquality":quality,"enableaudio":0})
                    .to_string()
                    .as_bytes(),
            );
            let command = crypto::encrypt_media(&provision.key, &request);
            timeout_at(deadline, connection.command(0x1001, &command))
                .await
                .map_err(|_| StartFailure::Transport(format!(
                    "[stage=camera.{route}.start_video code=camera_send_timeout] MISS video start send deadline elapsed"
                )))?
                .map_err(|error| StartFailure::Transport(format!("[stage=camera.{route}.start_video] {error}")))?;
        }
        Ok(Self {
            connection,
            key: provision.key,
            route,
        })
    }

    pub fn route(&self) -> &'static str {
        self.route
    }

    pub async fn close_lan_attempt(&self) -> Result<(), String> {
        timeout(
            Duration::from_millis(400),
            send_packet(&self.connection.sender, message(0xf0, &[])),
        )
        .await
        .map_err(
            |_| "[stage=camera.lan.close code=camera_send_timeout] CS2 CLOSE send deadline elapsed",
        )?
        .map_err(|error| format!("[stage=camera.lan.close] {error}"))
    }

    pub fn command_handle(&self) -> CommandHandle {
        CommandHandle {
            sender: self.connection.sender.clone(),
            sequence: self.connection.sequence.clone(),
            key: self.key,
        }
    }
    pub async fn video(&mut self) -> Result<VideoPacket, StartFailure> {
        let route = self.route;
        timeout(Duration::from_secs(15), self.read_video())
            .await
            .map_err(|_| StartFailure::Transport(format!("[stage=camera.{route}.media code=camera_media_timeout] no video packet before deadline")))?
    }

    async fn read_video(&mut self) -> Result<VideoPacket, StartFailure> {
        let failure = |reason: &str| {
            StartFailure::Transport(format!("[stage=camera.{}.media] {reason}", self.route))
        };
        loop {
            let (channel, data) = self
                .connection
                .receive()
                .await
                .map_err(|error| failure(&error))?;
            if channel == 0 {
                if let Some(reason) = video_start_rejection(&data, &self.key) {
                    return Err(StartFailure::Terminal(format!(
                        "[stage=camera.{}.start_video code=camera_video_start_rejected] {reason}",
                        self.route
                    )));
                }
                continue;
            }
            if channel != 2 {
                continue;
            }
            if data.len() < 40 {
                return Err(failure("camera_media_truncated"));
            }
            let length = u32::from_le_bytes(data[0..4].try_into().unwrap()) as usize;
            if length != data.len() - 32 {
                return Err(failure("camera_media_length_invalid"));
            }
            let codec = u32::from_le_bytes(data[4..8].try_into().unwrap());
            if ![4, 5].contains(&codec) {
                continue;
            }
            return Ok(VideoPacket {
                codec,
                timestamp_ms: u64::from_le_bytes(data[16..24].try_into().unwrap()),
                data: crypto::decrypt_media(&self.key, &data[32..])
                    .map_err(|error| failure(&error))?,
            });
        }
    }
}

fn is_reply(bytes: &[u8], kind: u32) -> bool {
    bytes
        .get(..4)
        .is_some_and(|header| header == kind.to_le_bytes() || header == kind.to_be_bytes())
}

fn video_start_rejection(bytes: &[u8], key: &[u8; 32]) -> Option<String> {
    let decoded;
    let reply = if is_reply(bytes, 0x1001) {
        decoded = crypto::decrypt_media(key, bytes.get(4..)?).ok()?;
        &decoded
    } else {
        bytes
    };
    if !is_reply(reply, 0x103) {
        return None;
    }
    let response: serde_json::Value = serde_json::from_slice(reply.get(4..)?).ok()?;
    if let Some(code) = response["code"].as_i64().filter(|code| *code != 0) {
        return Some(format!("camera returned code {code}"));
    }
    let result = &response["result"];
    if result.as_bool() == Some(false)
        || matches!(
            result.as_str(),
            Some("fail" | "failed" | "error" | "denied")
        )
    {
        return Some("camera declined to start video".into());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_explicit_start_rejection_is_terminal() {
        let key = [11; 32];
        let response = [0x103u32.to_le_bytes().as_slice(), br#"{"code":-13}"#].concat();
        let encoded = [
            0x1001u32.to_be_bytes().as_slice(),
            &crypto::encrypt_media(&key, &response),
        ]
        .concat();
        assert_eq!(
            video_start_rejection(&response, &key).as_deref(),
            Some("camera returned code -13")
        );
        assert_eq!(
            video_start_rejection(&encoded, &key),
            video_start_rejection(&response, &key)
        );
        let unrelated = [0x110u32.to_le_bytes().as_slice(), &response[4..]].concat();
        assert_eq!(video_start_rejection(&unrelated, &key), None);
        let accepted = [
            0x103u32.to_le_bytes().as_slice(),
            br#"{"result":"success","code":0}"#,
        ]
        .concat();
        assert_eq!(video_start_rejection(&accepted, &key), None);
    }
}
