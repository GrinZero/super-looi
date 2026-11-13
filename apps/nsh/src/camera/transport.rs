//! CS2 TCP transport, with the mandatory UDP LAN negotiation.
//! Adapted from Xiaomi Camera Native / go2rtc (MIT; native/licenses/xiaomi-camera).
use super::{cloud::Provision, crypto, video::VideoPacket};
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
    time::{Instant, timeout},
};
const LIMIT: usize = 8 * 1024 * 1024;
type Incoming = Result<(u8, Vec<u8>), String>;
type Outgoing = (Vec<u8>, Option<oneshot::Sender<Result<(), String>>>);
fn message(kind: u8, data: &[u8]) -> Vec<u8> {
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
) -> Result<Vec<u8>, String> {
    let deadline = Instant::now() + Duration::from_secs(8);
    let mut buffer = [0; 65535];
    while Instant::now() < deadline {
        socket
            .send_to(packet, *remote)
            .await
            .map_err(|_| "camera_discovery_send")?;
        let attempt = (Instant::now() + Duration::from_secs(1)).min(deadline);
        while Instant::now() < attempt {
            let Ok(result) = timeout(attempt - Instant::now(), socket.recv_from(&mut buffer)).await
            else {
                break;
            };
            let (length, address) = result.map_err(|_| "camera_discovery_receive")?;
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
    Err("camera_cs2_handshake_timeout".into())
}
struct Connection {
    sender: mpsc::Sender<Outgoing>,
    receiver: mpsc::Receiver<Incoming>,
    reader: JoinHandle<()>,
    writer: JoinHandle<()>,
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
        let (receipt, result) = oneshot::channel();
        self.sender
            .send((message(0xd0, &data), Some(receipt)))
            .await
            .map_err(|_| "camera_connection_ended")?;
        result.await.map_err(|_| "camera_connection_ended")?
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
    async fn connect(host: &str) -> Result<Self, String> {
        let ip: Ipv4Addr = host.parse().map_err(|_| "camera_lan_ip_missing")?;
        let mut remote = SocketAddr::from((ip, 32108));
        let socket = UdpSocket::bind("0.0.0.0:0")
            .await
            .map_err(|_| "camera_discovery_socket")?;
        let punch = exchange(&socket, &mut remote, &message(0x30, &[]), &[0x41]).await?;
        let ready = exchange(&socket, &mut remote, &punch, &[0x42, 0x43]).await?;
        if ready[1] != 0x43 {
            return Err("camera_cs2_tcp_unavailable".into());
        }
        drop(socket);
        let stream = timeout(Duration::from_secs(8), TcpStream::connect(remote))
            .await
            .map_err(|_| "camera_tcp_timeout")?
            .map_err(|_| "camera_tcp_connect")?;
        stream
            .set_nodelay(true)
            .map_err(|_| "camera_tcp_configure")?;
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
                        .map_err(|_| "camera_connection_ended")?;
                    let size = u16::from_be_bytes([header[0], header[1]]) as usize;
                    if header[2] != 0x68 || size < 4 {
                        return Err("camera_tcp_frame_invalid".into());
                    }
                    let mut packet = vec![0; size];
                    read.read_exact(&mut packet)
                        .await
                        .map_err(|_| "camera_connection_ended")?;
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
                    .and_then(|r| r.map_err(|_| "camera_send_failed".to_owned()));
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
            writer,
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
        let (receipt, result) = oneshot::channel();
        self.sender
            .send((message(0xd0, &data), Some(receipt)))
            .await
            .map_err(|_| "camera_connection_ended")?;
        result.await.map_err(|_| "camera_connection_ended")?
    }
    async fn receive(&mut self) -> Result<(u8, Vec<u8>), String> {
        timeout(Duration::from_secs(15), self.receiver.recv())
            .await
            .map_err(|_| "camera_media_timeout")?
            .ok_or("camera_connection_ended".to_owned())?
    }
}
impl Drop for Connection {
    fn drop(&mut self) {
        self.reader.abort();
        self.writer.abort();
    }
}
pub struct Miss {
    connection: Connection,
    key: [u8; 32],
}
impl Miss {
    pub async fn connect(host: &str, provision: Provision, model: &str) -> Result<Self, String> {
        Self::connect_with_options(host, provision, model, true).await
    }

    pub async fn connect_with_options(
        host: &str,
        provision: Provision,
        model: &str,
        start_video: bool,
    ) -> Result<Self, String> {
        let mut connection = Connection::connect(host).await?;
        let auth = json!({"public_key":crypto::hex(&provision.public),"sign":provision.sign,"uuid":"","support_encrypt":0});
        connection
            .command(0x100, auth.to_string().as_bytes())
            .await?;
        loop {
            let (channel, response) = connection.receive().await?;
            if channel != 0 {
                continue;
            }
            let auth: serde_json::Value =
                serde_json::from_slice(response.get(4..).ok_or("camera_auth_response_invalid")?)
                    .map_err(|_| "camera_auth_response_invalid")?;
            if auth["result"] != "success" {
                return Err("camera_auth_rejected".into());
            }
            break;
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
            connection
                .command(0x1001, &crypto::encrypt_media(&provision.key, &request))
                .await?;
        }
        Ok(Self {
            connection,
            key: provision.key,
        })
    }

    pub fn command_handle(&self) -> CommandHandle {
        CommandHandle {
            sender: self.connection.sender.clone(),
            sequence: self.connection.sequence.clone(),
            key: self.key,
        }
    }
    pub async fn video(&mut self) -> Result<VideoPacket, String> {
        loop {
            let (channel, data) = self.connection.receive().await?;
            if channel != 2 {
                continue;
            }
            if data.len() < 40 {
                return Err("camera_media_truncated".into());
            }
            let length = u32::from_le_bytes(data[0..4].try_into().unwrap()) as usize;
            if length != data.len() - 32 {
                return Err("camera_media_length_invalid".into());
            }
            let codec = u32::from_le_bytes(data[4..8].try_into().unwrap());
            if ![4, 5].contains(&codec) {
                continue;
            }
            return Ok(VideoPacket {
                codec,
                timestamp_ms: u64::from_le_bytes(data[16..24].try_into().unwrap()),
                data: crypto::decrypt_media(&self.key, &data[32..])?,
            });
        }
    }
}
