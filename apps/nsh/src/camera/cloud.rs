//! xiaomiio account and per-connection provisioning. HA OAuth remains separate.
use super::crypto;
use base64::{Engine, engine::general_purpose::STANDARD};
use md5::{Digest, Md5};
use reqwest::{Client, Method, header};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::HashMap, time::Duration};

#[derive(Default, Clone, Serialize, Deserialize)]
pub struct Credentials {
    pub region: String,
    user_id: String,
    pass_token: String,
    service_token: String,
    c_user_id: String,
    security: String,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Device {
    pub did: String,
    pub name: String,
    pub model: String,
    pub host: String,
    pub online: bool,
}
pub struct Provision {
    pub public: [u8; 32],
    pub key: [u8; 32],
    pub sign: String,
}
#[derive(Default)]
struct Attempt {
    username: String,
    password: String,
    captcha: String,
    ick: String,
    flag: String,
    identity: String,
    pending: String,
    captcha_url: String,
    step: LoginStep,
}
#[derive(Default, Clone)]
enum LoginStep {
    #[default]
    Password,
    SendTicket,
    Verify(String),
    Redirect,
    Discover,
}
pub struct Cloud {
    login: Client,
    api: Client,
    pub credentials: Credentials,
    cookies: HashMap<String, HashMap<String, String>>,
    attempt: Attempt,
    pub state: Value,
    #[cfg(test)]
    test_base: Option<url::Url>,
}
impl Cloud {
    pub fn new(region: &str) -> Result<Self, String> {
        if !["cn", "de", "i2", "ru", "sg", "us"].contains(&region) {
            return Err("camera_region_unsupported".into());
        }
        Ok(Self {
            login: Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(20))
                .user_agent("Go-http-client/1.1")
                .build()
                .map_err(|_| "camera_http_init")?,
            api: Client::builder()
                .http1_only()
                .timeout(Duration::from_secs(20))
                .user_agent("Go-http-client/1.1")
                .build()
                .map_err(|_| "camera_http_init")?,
            #[cfg(test)]
            test_base: None,
            credentials: Credentials {
                region: region.into(),
                ..Default::default()
            },
            cookies: HashMap::new(),
            attempt: Attempt::default(),
            state: json!({"state":"signed_out"}),
        })
    }
    fn take_fields(&mut self, data: &Value) {
        for (name, target) in [
            ("userId", &mut self.credentials.user_id),
            ("passToken", &mut self.credentials.pass_token),
            ("serviceToken", &mut self.credentials.service_token),
            ("cUserId", &mut self.credentials.c_user_id),
            ("ssecurity", &mut self.credentials.security),
        ] {
            if let Some(value) = data.get(name).filter(|v| !v.is_null()) {
                let value = value
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| value.to_string());
                if !value.is_empty() {
                    *target = value;
                }
            }
        }
    }
    fn account_url(&self, value: &str) -> Result<url::Url, String> {
        let base = url::Url::parse("https://account.xiaomi.com").unwrap();
        let mut url = base
            .join(value)
            .map_err(|_| "camera_login_redirect_invalid")?;
        #[cfg(test)]
        if self
            .test_base
            .as_ref()
            .is_some_and(|base| url.origin() == base.origin())
        {
            return Ok(url);
        }
        let host = url.host_str().unwrap_or("");
        if url.scheme() != "https"
            || !(host == "xiaomi.com"
                || host.ends_with(".xiaomi.com")
                || host == "mi.com"
                || host.ends_with(".mi.com"))
        {
            return Err("camera_login_redirect_invalid".into());
        }
        if self.credentials.region == "cn" && host == "account.xiaomi.com" {
            url.set_host(Some("cn.account.xiaomi.com")).unwrap();
        }
        #[cfg(test)]
        if let Some(base) = &self.test_base {
            url.set_scheme(base.scheme()).unwrap();
            url.set_host(base.host_str()).unwrap();
            url.set_port(base.port()).unwrap();
        }
        Ok(url)
    }
    async fn raw(
        &mut self,
        method: Method,
        location: &str,
        form: &[(&str, String)],
        query: &[(&str, String)],
        extra_cookies: &[(&str, String)],
    ) -> Result<(Vec<u8>, Option<String>), String> {
        let url = self.account_url(location)?;
        let host = url.host_str().unwrap().to_owned();
        let mut cookies = self.cookies.get(&host).cloned().unwrap_or_default();
        cookies.extend(
            extra_cookies
                .iter()
                .map(|(k, v)| (k.to_string(), v.clone())),
        );
        let mut request = self.login.request(method, url.clone()).query(query);
        if !form.is_empty() {
            request = request.form(form);
        }
        if !cookies.is_empty() {
            request = request.header(
                header::COOKIE,
                cookies
                    .iter()
                    .map(|(k, v)| format!("{k}={v}"))
                    .collect::<Vec<_>>()
                    .join("; "),
            );
        }
        let response = request.send().await.map_err(|_| "camera_login_network")?;
        let status = response.status();
        let mut fields = serde_json::Map::new();
        for cookie in response.headers().get_all(header::SET_COOKIE) {
            if let Ok(raw) = cookie.to_str() {
                if let Some((name, value)) = raw.split(';').next().and_then(|v| v.split_once('=')) {
                    if !value.is_empty() {
                        self.cookies
                            .entry(host.clone())
                            .or_default()
                            .insert(name.into(), value.into());
                        fields.insert(name.into(), value.into());
                    }
                }
            }
        }
        self.take_fields(&Value::Object(fields));
        if let Some(extra) = response
            .headers()
            .get("Extension-Pragma")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| serde_json::from_str::<Value>(v).ok())
        {
            self.take_fields(&extra);
        }
        let next = response
            .headers()
            .get(header::LOCATION)
            .and_then(|v| v.to_str().ok())
            .map(|v| {
                url.join(v)
                    .map(|v| v.to_string())
                    .map_err(|_| "camera_login_redirect_invalid")
            })
            .transpose()?;
        if !status.is_success() && !status.is_redirection() {
            return Err(format!("camera_login_http_{}", status.as_u16()));
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|_| "camera_login_network")?
            .to_vec();
        Ok((bytes, next))
    }
    async fn request(
        &mut self,
        method: Method,
        path: &str,
        form: &[(&str, String)],
        query: &[(&str, String)],
        cookies: &[(&str, String)],
    ) -> Result<Value, String> {
        let (body, _) = self.raw(method, path, form, query, cookies).await?;
        let data: Value =
            serde_json::from_slice(body.strip_prefix(b"&&&START&&&").unwrap_or(&body))
                .map_err(|_| "camera_login_response_invalid")?;
        self.take_fields(&data);
        Ok(data)
    }
    pub async fn password(&mut self, username: String, password: String) -> Result<(), String> {
        self.attempt = Attempt {
            username,
            password,
            ..Default::default()
        };
        self.password_step().await
    }
    async fn password_step(&mut self) -> Result<(), String> {
        self.attempt.step = LoginStep::Password;
        let init = self
            .request(
                Method::GET,
                "/pass/serviceLogin",
                &[],
                &[("_json", "true".into()), ("sid", "xiaomiio".into())],
                &[],
            )
            .await?;
        let mut form = Vec::new();
        for key in ["sid", "callback", "_sign", "qs"] {
            form.push((
                key,
                init[key]
                    .as_str()
                    .ok_or("camera_login_init_failed")?
                    .to_owned(),
            ));
        }
        form.extend([
            ("_json", "true".into()),
            ("user", self.attempt.username.clone()),
            (
                "hash",
                crypto::hex(&Md5::digest(self.attempt.password.as_bytes())).to_uppercase(),
            ),
        ]);
        if !self.attempt.captcha.is_empty() {
            form.push(("captCode", self.attempt.captcha.clone()));
        }
        let result = self
            .request(
                Method::POST,
                "/pass/serviceLoginAuth2",
                &form,
                &[],
                &[
                    ("deviceId", crypto::hex(&crypto::random::<8>())),
                    ("ick", self.attempt.ick.clone()),
                ],
            )
            .await?;
        if let Some(path) = result["captchaURL"].as_str().filter(|v| !v.is_empty()) {
            let rejected = !self.attempt.captcha.is_empty();
            self.captcha(path).await?;
            if rejected {
                self.state["error"] = "camera_captcha_rejected".into();
            }
            return Ok(());
        }
        if let Some(notification) = result["notificationUrl"].as_str().filter(|v| !v.is_empty()) {
            let details = self
                .request(
                    Method::GET,
                    &notification.replacen("/fe/service/identity/authStart", "/identity/list", 1),
                    &[],
                    &[],
                    &[],
                )
                .await?;
            self.attempt.flag = details["flag"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| details["flag"].to_string());
            self.attempt.identity = self
                .cookies
                .values()
                .find_map(|c| c.get("identity_session").cloned())
                .unwrap_or_default();
            if !["4", "8"].contains(&self.attempt.flag.as_str()) || self.attempt.identity.is_empty()
            {
                return Err("camera_verification_unsupported".into());
            }
            return self.send_ticket().await;
        }
        self.attempt.pending = result["location"]
            .as_str()
            .ok_or("camera_password_rejected")?
            .into();
        self.finish().await
    }
    async fn captcha(&mut self, path: &str) -> Result<(), String> {
        self.attempt.captcha_url = path.into();
        let (image, _) = self.raw(Method::GET, path, &[], &[], &[]).await?;
        self.attempt.ick = self
            .cookies
            .values()
            .find_map(|c| c.get("ick").cloned())
            .unwrap_or_default();
        self.state = json!({"state":"captcha","image":format!("data:image/jpeg;base64,{}",STANDARD.encode(image))});
        Ok(())
    }
    fn verification_name(&self) -> &'static str {
        if self.attempt.flag == "4" {
            "Phone"
        } else {
            "Email"
        }
    }
    async fn send_ticket(&mut self) -> Result<(), String> {
        self.attempt.step = LoginStep::SendTicket;
        let name = self.verification_name();
        let cookies = [
            ("identity_session", self.attempt.identity.clone()),
            ("ick", self.attempt.ick.clone()),
        ];
        let details = self
            .request(
                Method::GET,
                &format!("/identity/auth/verify{name}"),
                &[],
                &[
                    ("_flag", self.attempt.flag.clone()),
                    ("_json", "true".into()),
                ],
                &cookies,
            )
            .await?;
        let result = self
            .request(
                Method::POST,
                &format!("/identity/auth/send{name}Ticket"),
                &[
                    ("_json", "true".into()),
                    ("icode", self.attempt.captcha.clone()),
                    ("retry", "0".into()),
                ],
                &[],
                &cookies,
            )
            .await?;
        if let Some(path) = result["captchaURL"].as_str().filter(|v| !v.is_empty()) {
            let rejected = !self.attempt.captcha.is_empty();
            self.captcha(path).await?;
            if rejected {
                self.state["error"] = "camera_captcha_rejected".into();
            }
            return Ok(());
        }
        if result["code"] != 0 {
            return Err("camera_verification_send_failed".into());
        }
        self.attempt.captcha.clear();
        self.state = json!({"state":"verification","destination":details["maskedPhone"].as_str().or(details["maskedEmail"].as_str()).unwrap_or(""), "sentAt":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64});
        Ok(())
    }
    pub async fn refresh_captcha(&mut self) -> Result<(), String> {
        let path = self.attempt.captcha_url.clone();
        if self.state["state"] != "captcha" || path.is_empty() {
            return Err("camera_challenge_missing".into());
        }
        self.attempt.captcha.clear();
        self.captcha(&path).await
    }
    pub async fn resend_ticket(&mut self) -> Result<(), String> {
        if self.attempt.identity.is_empty() {
            return Err("camera_challenge_missing".into());
        }
        self.attempt.captcha.clear();
        self.send_ticket().await
    }
    pub async fn submit(&mut self, answer: String) -> Result<(), String> {
        if self.state["state"] == "captcha" {
            self.attempt.captcha = answer.trim().into();
            if self.attempt.flag.is_empty() {
                return self.password_step().await;
            } else {
                return self.send_ticket().await;
            }
        }
        if self.state["state"] != "verification" {
            return Err("camera_challenge_missing".into());
        }
        self.verify_ticket(answer).await
    }
    async fn verify_ticket(&mut self, answer: String) -> Result<(), String> {
        self.attempt.step = LoginStep::Verify(answer.clone());
        let result = self
            .request(
                Method::POST,
                &format!("/identity/auth/verify{}", self.verification_name()),
                &[],
                &[
                    ("_flag", self.attempt.flag.clone()),
                    ("ticket", answer.trim().into()),
                    ("trust", "false".into()),
                    ("_json", "true".into()),
                ],
                &[("identity_session", self.attempt.identity.clone())],
            )
            .await?;
        self.attempt.pending = result["location"]
            .as_str()
            .ok_or("camera_verification_rejected")?
            .into();
        self.finish().await
    }
    pub async fn finish(&mut self) -> Result<(), String> {
        if self.attempt.pending.is_empty() {
            return Err("camera_login_continuation_missing".into());
        }
        self.state = json!({"state":"continuing"});
        self.attempt.step = LoginStep::Redirect;
        for _ in 0..10 {
            let location = self.attempt.pending.clone();
            let (body, next) = self.raw(Method::GET, &location, &[], &[], &[]).await?;
            let data = body.strip_prefix(b"&&&START&&&").unwrap_or(&body);
            let json = serde_json::from_slice::<Value>(data).ok();
            if let Some(data) = &json {
                self.take_fields(data);
            }
            if let Some(next) = next {
                self.attempt.pending = next;
                continue;
            }
            if let Some(next) = json
                .as_ref()
                .filter(|data| data["code"] == 0)
                .and_then(|data| data["location"].as_str())
                .filter(|v| !v.is_empty())
            {
                self.attempt.pending = self
                    .account_url(&location)?
                    .join(next)
                    .map_err(|_| "camera_login_redirect_invalid")?
                    .to_string();
                continue;
            }
            return self.complete_discovery().await;
        }
        Err("camera_login_redirect_limit".into())
    }
    async fn complete_discovery(&mut self) -> Result<(), String> {
        self.attempt.step = LoginStep::Discover;
        self.state = json!({"state":"continuing"});
        let devices = self.devices().await?;
        self.attempt = Attempt::default();
        self.state = json!({"state":"ready","devices":devices});
        Ok(())
    }
    pub async fn resume(&mut self) -> Result<(), String> {
        if self.state["state"] == "ready" {
            return Ok(());
        }
        match self.attempt.step.clone() {
            LoginStep::Password => self.password_step().await,
            LoginStep::SendTicket => self.send_ticket().await,
            LoginStep::Verify(answer) => self.verify_ticket(answer).await,
            LoginStep::Redirect => self.finish().await,
            LoginStep::Discover => self.complete_discovery().await,
        }
    }
    pub async fn restore(&mut self, credentials: Credentials) -> Result<(), String> {
        self.credentials = credentials;
        match self.complete_discovery().await {
            Ok(()) => Ok(()),
            Err(error) if error == "camera_account_expired" => self.refresh().await,
            Err(error) => Err(error),
        }
    }
    pub async fn refresh(&mut self) -> Result<(), String> {
        let user = self.credentials.user_id.clone();
        let pass = self.credentials.pass_token.clone();
        self.credentials.service_token.clear();
        self.credentials.security.clear();
        let result = self
            .request(
                Method::GET,
                "/pass/serviceLogin",
                &[],
                &[("_json", "true".into()), ("sid", "xiaomiio".into())],
                &[("userId", user), ("passToken", pass)],
            )
            .await?;
        self.attempt.pending = result["location"]
            .as_str()
            .ok_or("camera_account_expired")?
            .into();
        self.finish().await
    }
    pub async fn api(&self, path: &str, data: Value) -> Result<Value, String> {
        let security = STANDARD
            .decode(&self.credentials.security)
            .map_err(|_| "camera_account_expired")?;
        if security.is_empty() || self.credentials.service_token.is_empty() {
            return Err("camera_account_expired".into());
        }
        let (form, signed) = crypto::cloud_request(&security, path, &data.to_string());
        let prefix = if self.credentials.region == "cn" {
            String::new()
        } else {
            format!("{}.", self.credentials.region)
        };
        let cookie = format!(
            "userId={}; cUserId={}; serviceToken={}",
            self.credentials.user_id, self.credentials.c_user_id, self.credentials.service_token
        );
        let api_url = format!("https://{prefix}api.io.mi.com/app{path}");
        #[cfg(test)]
        let api_url = self.test_base.as_ref().map_or(api_url, |base| {
            base.join(&format!("/app{path}")).unwrap().to_string()
        });
        let response = self
            .api
            .post(api_url)
            .header(header::COOKIE, cookie)
            .header(header::ACCEPT, "*/*")
            .header(header::ACCEPT_ENCODING, "gzip, deflate")
            .form(&form)
            .send()
            .await
            .map_err(|_| "camera_cloud_network")?;
        if [401, 403].contains(&response.status().as_u16()) {
            return Err("camera_account_expired".into());
        }
        if !response.status().is_success() {
            return Err(format!("camera_cloud_http_{}", response.status().as_u16()));
        }
        let raw = response.bytes().await.map_err(|_| "camera_cloud_network")?;
        let result: Value = if let Ok(bytes) = STANDARD.decode(&raw) {
            serde_json::from_slice(&crypto::rc4(&signed, &bytes))
                .map_err(|_| "camera_cloud_response_invalid")?
        } else {
            serde_json::from_slice(&raw).map_err(|_| "camera_cloud_response_invalid")?
        };
        match result["code"].as_i64() {
            Some(0) => Ok(result["result"].clone()),
            Some(-10001 | -10000 | -10004 | 3) => Err("camera_account_expired".into()),
            Some(code) => Err(format!("camera_cloud_rejected_{code}")),
            None => Err("camera_cloud_response_invalid".into()),
        }
    }
    pub async fn devices(&self) -> Result<Vec<Device>, String> {
        let mut devices = Vec::new();
        let mut start = String::new();
        loop {
            let result = self
                .api(
                    "/v2/home/device_list_page",
                    json!({"start_did":start,"limit":200}),
                )
                .await?;
            let list = result["list"].as_array().ok_or("camera_devices_invalid")?;
            for raw in list {
                let model = raw["model"].as_str().unwrap_or("");
                if !model.contains(".camera.") && !model.contains(".cateye.") {
                    continue;
                }
                devices.push(Device {
                    did: raw["did"]
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| raw["did"].to_string()),
                    name: raw["name"].as_str().unwrap_or(model).into(),
                    model: model.into(),
                    host: raw["localip"].as_str().unwrap_or("").into(),
                    online: raw["isOnline"].as_bool().unwrap_or(true),
                });
            }
            let next = result["next_start_did"].as_str().unwrap_or("");
            if result["has_more"] != true || next.is_empty() || next == start {
                break;
            }
            start = next.into();
        }
        Ok(devices)
    }
    pub async fn provision(&self, did: &str) -> Result<Provision, String> {
        let (public, private) = crypto::keypair();
        let result = self.api("/v2/device/miss_get_vendor",json!({"app_pubkey":crypto::hex(&public),"did":did,"support_vendors":"TUTK_CS2_MTP"})).await?;
        if result["vendor"]["vendor"] != 4 {
            return Err("camera_vendor_unsupported".into());
        }
        Ok(Provision {
            public,
            key: crypto::shared(
                crypto::unhex32(
                    result["public_key"]
                        .as_str()
                        .ok_or("camera_session_key_missing")?,
                )?,
                private,
            )?,
            sign: result["sign"]
                .as_str()
                .ok_or("camera_session_sign_missing")?
                .into(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, Read, Write};

    /// Replays the actual HTTP sequence, including JSON callbacks and STS cookies.
    #[test]
    fn password_captcha_sms_sts_and_discovery_follow_server_results() {
        let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", server.local_addr().unwrap());
        let worker = std::thread::spawn(move || {
            let init = r#"{"sid":"xiaomiio","callback":"callback","_sign":"sign","qs":"query"}"#;
            let replies = [
                ("GET", "/pass/serviceLogin", init, ""),
                (
                    "POST",
                    "/pass/serviceLoginAuth2",
                    r#"{"captchaURL":"/pass/captcha"}"#,
                    "",
                ),
                (
                    "GET",
                    "/pass/captcha",
                    "actual-image-bytes",
                    "Set-Cookie: ick=test-ick; Path=/\r\n",
                ),
                (
                    "GET",
                    "/pass/captcha",
                    "new-image-bytes",
                    "Set-Cookie: ick=new-ick; Path=/\r\n",
                ),
                ("GET", "/pass/serviceLogin", init, ""),
                (
                    "POST",
                    "/pass/serviceLoginAuth2",
                    r#"{"notificationUrl":"https://account.xiaomi.com/fe/service/identity/authStart"}"#,
                    "",
                ),
                (
                    "GET",
                    "/identity/list",
                    r#"{"flag":4}"#,
                    "Set-Cookie: identity_session=real-session; Path=/\r\n",
                ),
                (
                    "GET",
                    "/identity/auth/verifyPhone",
                    r#"{"maskedPhone":"176****5310"}"#,
                    "",
                ),
                (
                    "POST",
                    "/identity/auth/sendPhoneTicket",
                    r#"{"code":0}"#,
                    "",
                ),
                (
                    "POST",
                    "/identity/auth/verifyPhone",
                    r#"{"code":70014}"#,
                    "",
                ),
                (
                    "GET",
                    "/identity/auth/verifyPhone",
                    r#"{"maskedPhone":"176****5310"}"#,
                    "",
                ),
                (
                    "POST",
                    "/identity/auth/sendPhoneTicket",
                    r#"{"code":0}"#,
                    "",
                ),
                (
                    "POST",
                    "/identity/auth/verifyPhone",
                    r#"{"location":"https://account.xiaomi.com/identity/result/check"}"#,
                    "",
                ),
                (
                    "GET",
                    "/identity/result/check",
                    r#"{"code":0,"location":"/pass/serviceLoginAuth2/end"}"#,
                    "",
                ),
                (
                    "GET",
                    "/pass/serviceLoginAuth2/end",
                    r#"{"code":0,"userId":"fixture-user","passToken":"fixture-pass","ssecurity":"AAECAwQFBgcICQoLDA0ODw==","location":"https://sts.api.io.mi.com/sts"}"#,
                    "",
                ),
                (
                    "GET",
                    "/sts",
                    "",
                    "Set-Cookie: serviceToken=fixture-token; Path=/\r\nSet-Cookie: cUserId=fixture-cuser; Path=/\r\n",
                ),
                (
                    "POST",
                    "/app/v2/home/device_list_page",
                    r#"{"code":0,"result":{"list":[{"did":"one","name":"Camera","model":"isa.camera.hlc7","localip":"192.0.2.1","isOnline":true},{"did":"two","model":"chuangmi.camera.039a01"},{"did":"light","model":"test.light.v1"}]}}"#,
                    "",
                ),
            ];
            for (method, path, body, extra) in replies {
                let (mut socket, _) = server.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut reader = std::io::BufReader::new(socket.try_clone().unwrap());
                let mut first = String::new();
                reader.read_line(&mut first).unwrap();
                assert!(
                    first.starts_with(&format!("{method} {path}")),
                    "unexpected request: {first}"
                );
                let mut headers = String::new();
                let mut length = 0;
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" {
                        break;
                    }
                    if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                        length = value.trim().parse().unwrap();
                    }
                    headers.push_str(&line);
                }
                let mut form = vec![0; length];
                reader.read_exact(&mut form).unwrap();
                if path == "/app/v2/home/device_list_page" {
                    assert!(headers.contains("serviceToken=fixture-token"));
                    assert!(headers.contains("cUserId=fixture-cuser"));
                    assert!(headers.contains("userId=fixture-user"));
                }
                write!(socket,"HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n{extra}\r\n{body}",body.len()).unwrap();
            }
        });
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let mut cloud = Cloud::new("cn").unwrap();
            cloud.test_base = Some(url::Url::parse(&base).unwrap());
            cloud
                .password("fixture-account".into(), "fixture-password".into())
                .await
                .unwrap();
            assert_eq!(cloud.state["state"], "captcha");
            assert!(
                cloud.state["image"]
                    .as_str()
                    .unwrap()
                    .ends_with(&STANDARD.encode("actual-image-bytes"))
            );
            cloud.refresh_captcha().await.unwrap();
            assert!(
                cloud.state["image"]
                    .as_str()
                    .unwrap()
                    .ends_with(&STANDARD.encode("new-image-bytes"))
            );
            cloud.submit("server-captcha".into()).await.unwrap();
            assert_eq!(cloud.state["state"], "verification");
            assert_eq!(cloud.state["destination"], "176****5310");
            assert!(cloud.state["sentAt"].as_u64().unwrap() > 0);
            assert_eq!(
                cloud.submit("123456".into()).await.unwrap_err(),
                "camera_verification_rejected"
            );
            assert_eq!(cloud.state["state"], "verification");
            cloud.resend_ticket().await.unwrap();
            cloud.submit("654321".into()).await.unwrap();
            assert_eq!(cloud.state["state"], "ready");
            assert_eq!(cloud.state["devices"].as_array().unwrap().len(), 2);
            assert!(cloud.attempt.password.is_empty());
        });
        worker.join().unwrap();
    }
}
