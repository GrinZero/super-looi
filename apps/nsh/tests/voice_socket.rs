use nsh_engine::EngineConfig;
use nsh_testing::{Headless, compile_tsx};
use std::{net::TcpListener, time::Duration};
use tokio_tungstenite::tungstenite::{
    self, Message,
    handshake::server::{Request, Response},
};

#[test]
fn authenticated_voice_socket_carries_text_pcm_ping_and_http_rejections() -> Result<(), String> {
    for rejected in [false, true] {
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|error| error.to_string())?;
        let url = format!(
            "ws://{}/v1/realtime?model=moss-live-1.0",
            listener.local_addr().unwrap()
        );
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(10)))
                .unwrap();
            let connection =
                tungstenite::accept_hdr(stream, move |request: &Request, response: Response| {
                    assert_eq!(
                        request.headers()["Authorization"],
                        "Bearer fixture-voice-key"
                    );
                    assert_eq!(request.uri().query(), Some("model=moss-live-1.0"));
                    if rejected {
                        Err(tungstenite::http::Response::builder()
                            .status(403)
                            .body(Some("voice model permission denied".into()))
                            .unwrap())
                    } else {
                        Ok(response)
                    }
                });
            if rejected {
                assert!(connection.is_err());
                return;
            }
            let mut socket = connection.unwrap();
            assert_eq!(socket.read().unwrap(), Message::Text("hello".into()));
            socket.send(Message::Ping(vec![1, 2].into())).unwrap();
            assert_eq!(socket.read().unwrap(), Message::Pong(vec![1, 2].into()));
            socket.send(Message::Text("hello".into())).unwrap();
            let pcm = Message::Binary(vec![0, 255, 1, 128].into());
            assert_eq!(socket.read().unwrap(), pcm);
            socket.send(pcm).unwrap();
            assert!(matches!(socket.read().unwrap(), Message::Close(_)));
        });
        let data = tempfile::tempdir().map_err(|error| error.to_string())?;
        let entry = data.path().join("Probe.tsx");
        std::fs::write(&entry, format!(r#"
import {{ mount, signal, Text }} from "nsh";
import {{ VoiceWebSocket }} from "super-looi/native";
function Probe() {{
  const status = signal("opening");
  const socket = new VoiceWebSocket({}, {{ Authorization: "Bearer fixture-voice-key" }});
  void (async () => {{
    try {{
      await socket.open();
      await socket.writeText("hello");
      const text = await socket.read();
      if (text?.text !== "hello") throw new Error("text mismatch");
      await socket.writeBytes(new Uint8Array([0, 255, 1, 128]));
      const frame = await socket.read();
      if (Array.from(frame?.bytes || []).join(",") !== "0,255,1,128") throw new Error("PCM mismatch");
      const pending = socket.read();
      await socket.close();
      if (await pending !== null) throw new Error("read was not cancelled");
      status.set("authenticated PCM verified");
    }} catch (error) {{ status.set(`${{error.code}}: ${{error.message}}`); }}
  }})();
  return <Text>{{status()}}</Text>;
}}
mount(Probe);
"#, serde_json::to_string(&url).unwrap())).map_err(|error| error.to_string())?;
        let sets = vec![nsh_base::registry(), nsh_app_nsh::registry()];
        let bundle = compile_tsx(&entry, &sets)?.with_capabilities_json(Some(
            r#"{"network":{"http":[{"host":"127.0.0.1","schemes":["http"],"methods":["GET"]}]}}"#,
        ))?;
        let mut config = EngineConfig::new(bundle);
        config.ui_sets = sets;
        let mut app = Headless::start(config).map_err(|error| error.to_string())?;
        let expected = if rejected {
            "HTTP_403: connect: HTTP error: 403 Forbidden: voice model permission denied"
        } else {
            "authenticated PCM verified"
        };
        app.wait_for_within(expected, Duration::from_secs(10))?;
        server.join().map_err(|_| "voice fixture server panicked")?;
    }
    Ok(())
}
