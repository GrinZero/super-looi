//! Navigation decisions contain no URL text; errors never expose OAuth codes.
use url::Url;

#[derive(Clone)]
pub struct Policy {
    redirect: Url,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Navigation {
    Allow,
    Block,
    Callback,
}

fn parse(value: &str) -> Result<Url, String> {
    if value.len() > 16_384 || value.chars().any(|c| c.is_control() || c == '\\') {
        return Err("miot_invalid_navigation".into());
    }
    let url = Url::parse(value).map_err(|_| "miot_invalid_navigation")?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err("miot_invalid_navigation".into());
    }
    Ok(url)
}

impl Policy {
    pub fn new(auth: &str, redirect: &str) -> Result<Self, String> {
        let redirect = parse(redirect)?;
        let callback_id = redirect.path().strip_prefix("/api/webhook/").unwrap_or("");
        if redirect.scheme() != "http"
            || redirect.host_str() != Some("homeassistant.local")
            || redirect.port() != Some(8123)
            || redirect.query().is_some()
            || redirect.fragment().is_some()
            || callback_id.is_empty()
            || !callback_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            return Err("miot_invalid_redirect".into());
        }
        let auth = parse(auth)?;
        if auth.scheme() != "https"
            || auth.host_str() != Some("account.xiaomi.com")
            || auth.port_or_known_default() != Some(443)
            || auth.path() != "/oauth2/authorize"
            || auth.fragment().is_some()
        {
            return Err("miot_invalid_authorization".into());
        }
        let values = |name: &str| {
            auth.query_pairs()
                .filter(|(key, _)| key == name)
                .map(|(_, value)| value.into_owned())
                .collect::<Vec<_>>()
        };
        if values("redirect_uri") != [redirect.as_str()]
            || values("response_type") != ["code"]
            || values("state").len() != 1
            || values("state")[0].len() != 40
            || !values("state")[0]
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        {
            return Err("miot_invalid_authorization".into());
        }
        Ok(Self { redirect })
    }

    pub fn navigation(&self, value: &str, main_frame: bool) -> Navigation {
        let Ok(url) = parse(value) else {
            return Navigation::Block;
        };
        // Block this hostname at every port/path/scheme, including subresources.
        if url.host_str() == Some("homeassistant.local") {
            return if main_frame
                && url.origin() == self.redirect.origin()
                && url.path() == self.redirect.path()
            {
                Navigation::Callback
            } else {
                Navigation::Block
            };
        }
        if url.scheme() == "https"
            && url.port_or_known_default() == Some(443)
            && (!main_frame || url.host_str() == Some("account.xiaomi.com"))
        {
            Navigation::Allow
        } else {
            Navigation::Block
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    pub fn fixture() -> (String, String) {
        let redirect = "http://homeassistant.local:8123/api/webhook/fixture-id".to_owned();
        let mut auth = Url::parse("https://account.xiaomi.com/oauth2/authorize").unwrap();
        auth.query_pairs_mut()
            .append_pair("redirect_uri", &redirect)
            .append_pair("response_type", "code")
            .append_pair("state", &"a".repeat(40));
        (auth.into(), redirect)
    }
    #[test]
    fn callback_is_intercepted_before_navigation_and_resources_never_pass() {
        let (auth, redirect) = fixture();
        let policy = Policy::new(&auth, &redirect).unwrap();
        for suffix in ["?state=bad&code=secret", "?error=denied", "#fragment", ""] {
            assert_eq!(
                policy.navigation(&format!("{redirect}{suffix}"), true),
                Navigation::Callback
            );
            assert_eq!(
                policy.navigation(&format!("{redirect}{suffix}"), false),
                Navigation::Block
            );
        }
        for url in [
            "http://homeassistant.local:8123/else",
            "https://homeassistant.local/pixel",
            "http://homeassistant.local:99/",
            "http://u@homeassistant.local:8123/api/webhook/fixture-id",
            "javascript:alert(1)",
            "file:///tmp/x",
            "intent://auth",
            "https://account.xiaomi.com.evil/",
            "https://account.xiaomi.com:8443/",
            "https://account.xiaomi.com\\@evil/",
        ] {
            assert_eq!(policy.navigation(url, true), Navigation::Block);
        }
        assert_eq!(policy.navigation(&auth, true), Navigation::Allow);
        assert_eq!(
            policy.navigation("https://cdn.example/asset", false),
            Navigation::Allow
        );
    }
    #[test]
    fn invalid_initial_urls_have_fixed_errors_without_secret_text() {
        let (auth, redirect) = fixture();
        for value in [
            auth.replace("account.xiaomi.com", "evil.example"),
            format!("{auth}&redirect_uri=secret"),
            format!("{auth}&state=secret"),
            auth.replace("response_type=code", "response_type=token"),
        ] {
            let error = Policy::new(&value, &redirect).err().unwrap();
            assert_eq!(error, "miot_invalid_authorization");
        }
        assert!(Policy::new(&auth, "http://homeassistant.local:8123/api/webhook/a%2fb").is_err());
    }
}
