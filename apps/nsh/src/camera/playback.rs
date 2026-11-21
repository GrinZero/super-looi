use std::future::Future;

pub(super) enum StartFailure {
    Transport(String),
    Terminal(String),
}

impl StartFailure {
    pub fn reason(self) -> String {
        match self {
            Self::Transport(reason) | Self::Terminal(reason) => reason,
        }
    }
}

pub(super) async fn lan_then_relay<T>(
    lan: impl Future<Output = Result<T, StartFailure>>,
    relay: impl Future<Output = Result<T, String>>,
) -> Result<T, String> {
    match lan.await {
        Ok(stream) => Ok(stream),
        Err(StartFailure::Terminal(error)) => Err(error),
        Err(StartFailure::Transport(lan_error)) => {
            eprintln!("[camera.playback] LAN attempt failed: {lan_error}");
            relay.await.map_err(|relay_error| {
                format!("[stage=camera.playback code=camera_routes_failed] LAN: {lan_error}\nRelay: {relay_error}")
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::Cell, future::ready};

    fn run<T>(future: impl Future<Output = T>) -> T {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(future)
    }

    #[test]
    fn lan_success_and_device_rejection_leave_relay_inactive() {
        let relay_calls = Cell::new(0);
        let relay = || async {
            relay_calls.set(relay_calls.get() + 1);
            Ok("relay")
        };
        assert_eq!(run(lan_then_relay(ready(Ok("lan")), relay())), Ok("lan"));
        assert_eq!(
            run(lan_then_relay(
                ready(Err(StartFailure::Terminal("camera_auth_rejected".into()))),
                relay(),
            )),
            Err("camera_auth_rejected".into()),
        );
        assert_eq!(relay_calls.get(), 0);
    }

    #[test]
    fn lan_first_frame_failure_uses_relay_and_preserves_both_failures() {
        let lan_failed = Cell::new(false);
        let lan = || async {
            lan_failed.set(true);
            Err(StartFailure::Transport(
                "camera_lan_first_frame_timeout".into(),
            ))
        };
        assert_eq!(
            run(lan_then_relay(lan(), async {
                assert!(lan_failed.get());
                Ok("relay")
            })),
            Ok("relay")
        );
        let error = run(lan_then_relay::<&str>(
            lan(),
            ready(Err("camera_relay_join_timeout".into())),
        ))
        .unwrap_err();
        assert!(error.contains("camera_lan_first_frame_timeout"));
        assert!(error.contains("camera_relay_join_timeout"));
    }
}
