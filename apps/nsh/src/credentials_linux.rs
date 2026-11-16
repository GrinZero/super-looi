use secret_service::{
    EncryptionType,
    blocking::{Collection, SecretService},
};
use std::{collections::HashMap, path::Path};

const SERVICE: &str = "com.superlooi.app.credentials.v1";

fn attributes(slot: &str) -> HashMap<&str, &str> {
    HashMap::from([("service", SERVICE), ("account", slot)])
}

fn failure(operation: &str, stage: &str, error: impl std::fmt::Debug) -> String {
    format!("Secret Service {operation}/{stage} failed: {error:?}")
}

fn with_collection<T>(
    operation: &str,
    action: impl FnOnce(&Collection<'_>) -> Result<T, String>,
) -> Result<T, String> {
    // Connect directly so a missing bus retains its address/IO error instead of
    // secret-service's generic Unavailable mapping. async-io owns the IO loop.
    let connection = zbus::blocking::Connection::session()
        .map_err(|error| failure(operation, "connect-session-bus", error))?;
    let service = SecretService::connect_with_existing(EncryptionType::Dh, connection)
        .map_err(|error| failure(operation, "open-encrypted-session", error))?;
    let collection = service
        .get_default_collection()
        .map_err(|error| failure(operation, "open-default-collection", error))?;
    if collection
        .is_locked()
        .map_err(|error| failure(operation, "check-lock", error))?
    {
        collection
            .unlock()
            .map_err(|error| failure(operation, "unlock", error))?;
    }
    action(&collection)
}

pub fn get(_: &Path, slot: &str) -> Result<String, String> {
    with_collection("read", |collection| {
        let items = collection
            .search_items(attributes(slot))
            .map_err(|error| failure("read", "search", error))?;
        let Some(item) = items.first() else {
            return Ok(String::new());
        };
        let bytes = item
            .get_secret()
            .map_err(|error| failure("read", "get-secret", error))?;
        String::from_utf8(bytes).map_err(|error| failure("read", "decode", error.utf8_error()))
    })
}

pub fn set(_: &Path, slot: &str, value: &[u8]) -> Result<(), String> {
    with_collection("write", |collection| {
        collection
            .create_item(
                &format!("Super LOOI: {slot}"),
                attributes(slot),
                value,
                true,
                "text/plain; charset=utf-8",
            )
            .map_err(|error| failure("write", "create-or-replace", error))?;
        Ok(())
    })
}

pub fn remove(_: &Path, slot: &str) -> Result<(), String> {
    with_collection("delete", |collection| {
        let items = collection
            .search_items(attributes(slot))
            .map_err(|error| failure("delete", "search", error))?;
        for item in items {
            item.delete()
                .map_err(|error| failure("delete", "delete-item", error))?;
        }
        Ok(())
    })
}
