use crate::domain::*;

pub trait Vault: Send + Sync {
    fn get(&self, slot: &str) -> Result<Option<String>>;
    fn set(&self, slot: &str, value: &str) -> Result<()>;
    fn delete(&self, slot: &str) -> Result<()>;
}
pub struct SystemVault;
fn unavailable() -> AppError {
    AppError::new(
        "KEY_UNAVAILABLE",
        "系统凭证存储不可用或被拒绝。请检查系统凭证服务；不会改用明文保存。",
    )
}
impl Vault for SystemVault {
    fn get(&self, slot: &str) -> Result<Option<String>> {
        let entry =
            keyring::Entry::new("io.superoffer.desktop", slot).map_err(|_| unavailable())?;
        match entry.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(unavailable()),
        }
    }
    fn set(&self, slot: &str, value: &str) -> Result<()> {
        keyring::Entry::new("io.superoffer.desktop", slot)
            .map_err(|_| unavailable())?
            .set_password(value)
            .map_err(|_| unavailable())
    }
    fn delete(&self, slot: &str) -> Result<()> {
        match keyring::Entry::new("io.superoffer.desktop", slot)
            .map_err(|_| unavailable())?
            .delete_credential()
        {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(unavailable()),
        }
    }
}
