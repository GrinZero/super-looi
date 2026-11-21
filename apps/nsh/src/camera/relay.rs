//! CS2 directory discovery and UDP transport for Xiaomi's public media relay.
use super::transport::{Incoming, LIMIT, Outgoing, message};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    io,
    net::{Ipv4Addr, SocketAddr, SocketAddrV4},
    time::Duration,
};
use tokio::{
    net::{UdpSocket, lookup_host},
    sync::mpsc,
    time::{Instant, interval, timeout_at},
};

// CS2 init-string wire table, documented by go2rtc PR #2631.
const INIT_TABLE: [u8; 54] = [
    0x49, 0x59, 0x43, 0x3d, 0xb5, 0xbf, 0x6d, 0xa3, 0x47, 0x53, 0x4f, 0x61, 0x65, 0xe3, 0x71, 0xe9,
    0x67, 0x7f, 0x02, 0x03, 0x0b, 0xad, 0xb3, 0x89, 0x2b, 0x2f, 0x35, 0xc1, 0x6b, 0x8b, 0x95, 0x97,
    0x11, 0xe5, 0xa7, 0x0d, 0xef, 0xf1, 0x05, 0x07, 0x83, 0xfb, 0x9d, 0x3b, 0xc5, 0xc7, 0x13, 0x17,
    0x1d, 0x1f, 0x25, 0x29, 0xd3, 0xdf,
];
const DIRECTORY_PORT: u16 = 32100;
const RELAY_PORT: u16 = 25000;
const RESPONSE_TIME: Duration = Duration::from_secs(2);
const LIST_REQUEST: u8 = 0x67;
const RELAY_CANDIDATE: u8 = 0x82;
const REGISTER_RELAY: u8 = 0x83;
const RELAY_HELLO: u8 = 0x70;
const RELAY_HELLO_ACK: u8 = 0x71;
const RELAY_PORT_REQUEST: u8 = 0x72;
const RELAY_PORT_ACK: u8 = 0x73;
const JOIN_RELAY: u8 = 0x80;
const RELAY_READY: u8 = 0x84;
const LINK: u8 = 0x28;
const DATA: u8 = 0xd0;
const DATA_ACK: u8 = 0xd1;
const PING: u8 = 0xe0;
const PONG: u8 = 0xe1;
const CLOSE: u8 = 0xf0;
const CLOSE_ACK: u8 = 0xf1;

pub(super) struct Parameters {
    uid: [u8; 20],
    directory: String,
}

impl Parameters {
    pub fn from_cloud(value: &Value) -> Result<Self, String> {
        let parsed = value
            .as_str()
            .and_then(|text| serde_json::from_str::<Value>(text).ok());
        let params = parsed.as_ref().unwrap_or(value);
        let (Some(id), Some(init)) = (params["p2p_id"].as_str(), params["init_string"].as_str())
        else {
            return Err("[stage=camera.relay.provision code=camera_relay_parameters_missing] expected p2p_id and init_string".into());
        };
        let mut parts = id.split('-');
        let prefix = parts.next().unwrap_or_default().as_bytes();
        let serial = parts.next().and_then(|serial| serial.parse::<u32>().ok());
        let check = parts.next().unwrap_or_default().as_bytes();
        let invalid_uid = "[stage=camera.relay.provision code=camera_relay_uid_invalid] invalid CS2 identifier format";
        let serial = serial.ok_or(invalid_uid)?;
        if prefix.is_empty()
            || check.is_empty()
            || prefix.len() > 8
            || check.len() > 8
            || !prefix.is_ascii()
            || !check.is_ascii()
            || parts.next().is_some()
        {
            return Err(invalid_uid.into());
        }
        let mut uid = [0; 20];
        uid[..prefix.len()].copy_from_slice(prefix);
        uid[8..12].copy_from_slice(&serial.to_be_bytes());
        uid[12..12 + check.len()].copy_from_slice(check);
        let mut decoded = Vec::with_capacity(init.len() / 2);
        let mut previous = 0x39;
        let mut pairs = init.as_bytes().chunks_exact(2);
        let invalid_init = "[stage=camera.relay.provision code=camera_relay_init_invalid] invalid CS2 directory encoding";
        for (index, pair) in pairs.by_ref().enumerate() {
            if !pair.iter().all(|byte| (b'A'..=b'P').contains(byte)) {
                return Err(invalid_init.into());
            }
            let byte = ((pair[0] - b'A') << 4 | (pair[1] - b'A'))
                ^ INIT_TABLE[index % INIT_TABLE.len()]
                ^ previous;
            decoded.push(byte);
            previous ^= byte;
        }
        if decoded.is_empty() || !pairs.remainder().is_empty() {
            return Err(invalid_init.into());
        }
        Ok(Self {
            uid,
            directory: String::from_utf8(decoded).map_err(|_| invalid_init)?,
        })
    }

    async fn directory_addresses(&self) -> Result<BTreeSet<SocketAddr>, String> {
        let mut addresses = BTreeSet::new();
        for hostname in self
            .directory
            .split(',')
            .map(str::trim)
            .filter(|name| !name.is_empty())
        {
            let results = timeout_at(Instant::now() + RESPONSE_TIME, lookup_host((hostname, DIRECTORY_PORT)))
                .await
                .map_err(|_| "[stage=camera.relay.directory code=camera_relay_dns_timeout] CS2 directory DNS deadline elapsed")?
                .map_err(|error| io_error("directory", "camera_relay_dns", &error))?;
            addresses.extend(results.filter(SocketAddr::is_ipv4));
        }
        if addresses.is_empty() {
            return Err("[stage=camera.relay.directory code=camera_relay_directory_empty] no IPv4 directory server in init_string".into());
        }
        Ok(addresses)
    }
}

fn io_error(stage: &str, code: &str, error: &io::Error) -> String {
    format!("[stage=camera.relay.{stage} code={code}] {error}")
}

fn address(bytes: &[u8]) -> Option<SocketAddrV4> {
    let [0, 2, low_port, high_port, d, c, b, a, ..] = bytes else {
        return None;
    };
    let port = u16::from_le_bytes([*low_port, *high_port]);
    (port != 0).then(|| SocketAddrV4::new(Ipv4Addr::new(*a, *b, *c, *d), port))
}

fn address_block(address: SocketAddrV4) -> [u8; 16] {
    let mut result = [0; 16];
    result[1] = 2;
    result[2..4].copy_from_slice(&address.port().to_le_bytes());
    let mut ip = address.ip().octets();
    ip.reverse();
    result[4..8].copy_from_slice(&ip);
    result
}

fn packet(bytes: &[u8]) -> Option<(u8, &[u8])> {
    let [0xf1, kind, high, low, payload @ ..] = bytes else {
        return None;
    };
    (usize::from(u16::from_be_bytes([*high, *low])) == payload.len()).then_some((*kind, payload))
}

async fn send(
    socket: &UdpSocket,
    target: SocketAddr,
    kind: u8,
    body: &[u8],
    stage: &str,
) -> Result<(), String> {
    socket
        .send_to(&message(kind, body), target)
        .await
        .map_err(|error| io_error(stage, "camera_relay_send_failed", &error))?;
    Ok(())
}

async fn receive(
    socket: &UdpSocket,
    deadline: Instant,
    stage: &str,
    mut accept: impl FnMut(u8, &[u8], SocketAddr) -> bool,
) -> Result<Option<(Vec<u8>, SocketAddr)>, String> {
    let mut data = [0; 4096];
    while let Ok(result) = timeout_at(deadline, socket.recv_from(&mut data)).await {
        let (size, source) =
            result.map_err(|error| io_error(stage, "camera_relay_receive_failed", &error))?;
        if let Some((kind, body)) = packet(&data[..size]) {
            if accept(kind, body, source) {
                return Ok(Some((body.to_vec(), source)));
            }
        }
    }
    Ok(None)
}

pub(super) struct Peer {
    socket: UdpSocket,
    local: SocketAddrV4,
}

impl Peer {
    pub async fn connect(parameters: &Parameters) -> Result<Self, String> {
        let directory = parameters.directory_addresses().await?;
        let socket = UdpSocket::bind("0.0.0.0:0")
            .await
            .map_err(|error| io_error("socket", "camera_relay_bind_failed", &error))?;
        let mut candidates = BTreeMap::<SocketAddr, BTreeSet<[u8; 4]>>::new();
        let mut directory_replies = 0;
        for _ in 0..2 {
            for &server in &directory {
                send(&socket, server, LIST_REQUEST, &parameters.uid, "discover").await?;
            }
            receive(
                &socket,
                Instant::now() + RESPONSE_TIME,
                "discover",
                |kind, body, source| {
                    if !directory.contains(&source) {
                        return false;
                    }
                    directory_replies += 1;
                    if kind == RELAY_CANDIDATE && body.len() >= 20 {
                        if let Some(target) = address(&body[..16]) {
                            candidates
                                .entry(target.into())
                                .or_default()
                                .insert(body[16..20].try_into().unwrap());
                        }
                    }
                    false
                },
            )
            .await?;
            if !candidates.is_empty() {
                break;
            }
        }
        if candidates.is_empty() {
            return Err(format!(
                "[stage=camera.relay.discover code=camera_relay_candidates_missing] {} directory servers, {directory_replies} replies, no relay address",
                directory.len(),
            ));
        }

        let mut relay = None;
        for _ in 0..3 {
            for (&target, tokens) in &candidates {
                for token in tokens {
                    let registration = registration(&parameters.uid, token);
                    for _ in 0..4 {
                        send(&socket, target, REGISTER_RELAY, &registration, "hello").await?;
                    }
                }
                send(&socket, target, RELAY_HELLO, &[], "hello").await?;
            }
            relay = receive(
                &socket,
                Instant::now() + RESPONSE_TIME,
                "hello",
                |kind, _, source| {
                    kind == RELAY_HELLO_ACK
                        && candidates.keys().any(|target| target.ip() == source.ip())
                },
            )
            .await?
            .map(|(_, source)| SocketAddr::new(source.ip(), RELAY_PORT));
            if relay.is_some() {
                break;
            }
        }
        let relay = relay.ok_or(
            "[stage=camera.relay.hello code=camera_relay_hello_timeout] no RELAY_HELLO_ACK",
        )?;

        let mut allocated = None;
        for _ in 0..3 {
            send(&socket, relay, RELAY_PORT_REQUEST, &[], "allocate").await?;
            allocated = receive(
                &socket,
                Instant::now() + RESPONSE_TIME,
                "allocate",
                |kind, body, source| {
                    kind == RELAY_PORT_ACK && source.ip() == relay.ip() && body.len() >= 6
                },
            )
            .await?;
            if allocated.is_some() {
                break;
            }
        }
        let (body, _) = allocated.ok_or(
            "[stage=camera.relay.allocate code=camera_relay_allocate_timeout] no RELAY_PORT_ACK",
        )?;
        let token = body[..4].try_into().unwrap();
        let port = u16::from_be_bytes(body[4..6].try_into().unwrap());
        let relay_ip = match relay.ip() {
            std::net::IpAddr::V4(ip) => ip,
            std::net::IpAddr::V6(_) => unreachable!("relay candidates are IPv4"),
        };
        if port == 0 {
            return Err("[stage=camera.relay.allocate code=camera_relay_port_invalid] relay returned port zero".into());
        }
        let endpoint = SocketAddrV4::new(relay_ip, port);
        let mut join = parameters.uid.to_vec();
        join.extend(address_block(endpoint));
        join.extend(token);
        let registration = registration(&parameters.uid, &token);

        let mut ready = false;
        let mut directory_acks = 0;
        for _ in 0..6 {
            for &server in &directory {
                send(&socket, server, JOIN_RELAY, &join, "join").await?;
            }
            for _ in 0..24 {
                send(
                    &socket,
                    endpoint.into(),
                    REGISTER_RELAY,
                    &registration,
                    "join",
                )
                .await?;
            }
            ready = receive(
                &socket,
                Instant::now() + RESPONSE_TIME,
                "join",
                |kind, _, source| {
                    directory_acks += usize::from(kind == 0x81 && directory.contains(&source));
                    kind == RELAY_READY && source == SocketAddr::V4(endpoint)
                },
            )
            .await?
            .is_some();
            if ready {
                break;
            }
        }
        if !ready {
            return Err(format!(
                "[stage=camera.relay.join code=camera_relay_join_timeout] {directory_acks} directory acknowledgements, no RELAY_READY"
            ));
        }

        socket
            .connect(endpoint)
            .await
            .map_err(|error| io_error("link", "camera_relay_connect_failed", &error))?;
        let local = socket
            .local_addr()
            .map_err(|error| io_error("link", "camera_relay_local_address_failed", &error))?;
        let SocketAddr::V4(local) = local else {
            unreachable!("socket was bound on IPv4")
        };
        let (link, _) = receive(&socket, Instant::now() + Duration::from_secs(8), "link", |kind, body, _| {
            kind == LINK && body.len() >= 88 && body.starts_with(&[0xa1, 1])
        }).await?.ok_or("[stage=camera.relay.link code=camera_relay_link_timeout] no MISS link request after RELAY_READY")?;
        let peer = Self { socket, local };
        peer.reply_link(&link).await?;
        Ok(peer)
    }

    async fn reply_link(&self, body: &[u8]) -> Result<(), String> {
        let external = address(&body[40..56]).ok_or(
            "[stage=camera.relay.link code=camera_relay_link_address_invalid] invalid external address in MISS link",
        )?;
        let mut response = body.to_vec();
        response[1] = 2;
        response[56..60].copy_from_slice(&[0xfe, 0xff, 0xff, 0xff]);
        response[60..64]
            .copy_from_slice(&u32::from_be_bytes(body[4..8].try_into().unwrap()).to_le_bytes());
        response[64..80].copy_from_slice(&address_block(self.local));
        response[80..82].copy_from_slice(&[2, 0]);
        response[82..84].copy_from_slice(&external.port().to_be_bytes());
        response[84..88].copy_from_slice(&external.ip().octets());
        self.send(message(LINK, &response), "link").await
    }

    async fn send(&self, data: Vec<u8>, stage: &str) -> Result<(), String> {
        self.socket
            .send(&data)
            .await
            .map_err(|error| io_error(stage, "camera_relay_send_failed", &error))?;
        Ok(())
    }

    pub async fn run(
        self,
        mut commands: mpsc::Receiver<Outgoing>,
        incoming: mpsc::Sender<Incoming>,
    ) {
        if let Err(error) = self.transfer(&mut commands, &incoming).await {
            let _ = incoming.send(Err(error)).await;
        }
    }

    async fn transfer(
        &self,
        commands: &mut mpsc::Receiver<Outgoing>,
        incoming: &mpsc::Sender<Incoming>,
    ) -> Result<(), String> {
        let mut channels = [Channel::default(), Channel::default()];
        let mut ping = interval(Duration::from_secs(5));
        let mut data = [0; 65535];
        loop {
            tokio::select! {
                request = commands.recv() => {
                    let Some((bytes, receipt)) = request else { return Ok(()) };
                    let sent = self.send(bytes, "command").await;
                    if let Some(receipt) = receipt {
                        let _ = receipt.send(sent.clone());
                    }
                    sent?;
                }
                _ = ping.tick() => self.send(message(PING, &[]), "keepalive").await?,
                result = self.socket.recv(&mut data) => {
                    let size = result.map_err(|error| io_error("media", "camera_relay_receive_failed", &error))?;
                    match packet(&data[..size]) {
                        Some((DATA, [0xd1, channel @ (0 | 2), high, low, fragment @ ..])) => {
                            let sequence = u16::from_be_bytes([*high, *low]);
                            let channel_buffer = &mut channels[usize::from(*channel / 2)];
                            channel_buffer.push(sequence, fragment)?;
                            let ack = [0xd1, *channel, 0, 1, *high, *low];
                            self.send(message(DATA_ACK, &ack), "ack").await?;
                            while let Some(bytes) = channel_buffer.take()? {
                                if incoming.send(Ok((*channel, bytes))).await.is_err() {
                                    return Ok(());
                                }
                            }
                        }
                        Some((LINK, body)) if body.len() >= 88 && body.starts_with(&[0xa1, 1]) => self.reply_link(body).await?,
                        Some((PING, _)) => self.send(message(PONG, &[]), "keepalive").await?,
                        Some((CLOSE, _)) => {
                            self.send(message(CLOSE_ACK, &[]), "close").await?;
                            return Err("[stage=camera.relay.media code=camera_relay_peer_closed] relay sent CLOSE".into());
                        }
                        _ => {}
                    }
                }
            }
        }
    }
}

impl Drop for Peer {
    fn drop(&mut self) {
        let _ = self.socket.try_send(&[0xf1, CLOSE, 0, 0]);
    }
}

fn registration(uid: &[u8; 20], token: &[u8; 4]) -> [u8; 28] {
    let mut body = [0; 28];
    body[..4].copy_from_slice(token);
    body[4..24].copy_from_slice(uid);
    body
}

#[derive(Default)]
struct Channel {
    expected: u16,
    pending: BTreeMap<u16, Vec<u8>>,
    bytes: Vec<u8>,
}

impl Channel {
    fn push(&mut self, sequence: u16, fragment: &[u8]) -> Result<(), String> {
        let ahead = sequence.wrapping_sub(self.expected);
        if ahead >= 0x8000 {
            return Ok(());
        }
        if ahead > 1024 {
            return Err("[stage=camera.relay.media code=camera_relay_sequence_gap] CS2 fragments exceed receive window".into());
        }
        if ahead != 0 {
            self.pending
                .entry(sequence)
                .or_insert_with(|| fragment.to_vec());
            return Ok(());
        }
        self.bytes.extend(fragment);
        self.expected = self.expected.wrapping_add(1);
        while let Some(bytes) = self.pending.remove(&self.expected) {
            self.bytes.extend(bytes);
            self.expected = self.expected.wrapping_add(1);
        }
        Ok(())
    }

    fn take(&mut self) -> Result<Option<Vec<u8>>, String> {
        let Some(header) = self.bytes.get(..4) else {
            return Ok(None);
        };
        let size = u32::from_be_bytes(header.try_into().unwrap()) as usize;
        if size == 0 || size > LIMIT {
            return Err("[stage=camera.relay.media code=camera_relay_packet_size_invalid] invalid MISS message size".into());
        }
        if self.bytes.len() < 4 + size {
            return Ok(None);
        }
        Ok(Some(self.bytes.drain(..4 + size).skip(4).collect()))
    }
}
