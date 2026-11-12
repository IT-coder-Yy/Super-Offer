pub mod backup;
#[cfg(feature = "desktop")]
pub mod desktop;
pub mod domain;
pub mod files;
pub mod model;
pub mod store;
pub mod vault;

#[cfg(test)]
mod tests;
