use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const SCHEMA_VERSION: u32 = 1;
pub const CONTRACT_VERSION: u32 = 1;
pub const MAX_TEXT: usize = 1_000_000;
pub type Fields = BTreeMap<String, String>;
pub type Result<T> = std::result::Result<T, AppError>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppError {
    pub code: String,
    pub message: String,
}
impl AppError {
    pub fn new(code: &str, message: &str) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
    pub fn invalid(message: &str) -> Self {
        Self::new("INPUT_INVALID", message)
    }
}
impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for AppError {}
impl From<rusqlite::Error> for AppError {
    fn from(_: rusqlite::Error) -> Self {
        Self::new(
            "WRITE_FAILED",
            "本地数据库操作未完成。编辑已保留，请检查磁盘和数据目录后重试。",
        )
    }
}
impl From<std::io::Error> for AppError {
    fn from(_: std::io::Error) -> Self {
        Self::new(
            "FILE_FAILED",
            "文件操作未完成，请检查文件权限、可用空间及文件是否仍存在。",
        )
    }
}
impl From<serde_json::Error> for AppError {
    fn from(_: serde_json::Error) -> Self {
        Self::invalid("数据结构不正确或内容已损坏。")
    }
}
impl From<zip::result::ZipError> for AppError {
    fn from(_: zip::result::ZipError) -> Self {
        Self::invalid("压缩文件损坏、加密或使用了不支持的格式。")
    }
}

pub fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
pub fn text(value: &str, label: &str, required: bool, max: usize) -> Result<()> {
    if (required && value.trim().is_empty()) || value.len() > max || value.contains('\0') {
        return Err(AppError::invalid(&format!(
            "请检查{label}：不能为空或超过长度限制。"
        )));
    }
    Ok(())
}
pub fn timestamp(value: &str) -> Result<()> {
    chrono::DateTime::parse_from_rfc3339(value)
        .map_err(|_| AppError::invalid("时间须为包含时区的有效日期。"))?;
    Ok(())
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileData {
    #[serde(default)]
    pub basic: Fields,
    #[serde(default)]
    pub education: Vec<Fields>,
    #[serde(default)]
    pub experience: Vec<Fields>,
    #[serde(default)]
    pub projects: Vec<Fields>,
    #[serde(default)]
    pub skills: Fields,
    #[serde(default)]
    pub certificates: Vec<Fields>,
    #[serde(default)]
    pub intentions: Fields,
    #[serde(default)]
    pub answers: Vec<Fields>,
    pub resume_asset_id: Option<String>,
}
impl ProfileData {
    pub fn validate(&self) -> Result<()> {
        if serde_json::to_vec(self)?.len() > MAX_TEXT {
            return Err(AppError::invalid("档案文字超过 1 MB，请精简后保存。"));
        }
        for rows in [
            &self.education,
            &self.experience,
            &self.projects,
            &self.certificates,
            &self.answers,
        ] {
            if rows.len() > 200 {
                return Err(AppError::invalid("单类条目超过 200 条。"));
            }
            for row in rows {
                for (key, value) in row {
                    text(key, "字段名称", true, 80)?;
                    text(value, "字段内容", false, 100_000)?;
                }
                for key in ["startDate", "endDate", "date"] {
                    if let Some(date) = row.get(key).filter(|v| !v.is_empty()) {
                        validate_month_or_date(date)?;
                    }
                }
                if let (Some(start), Some(end)) = (
                    row.get("startDate").filter(|s| !s.is_empty()),
                    row.get("endDate").filter(|s| !s.is_empty()),
                ) && start > end
                {
                    return Err(AppError::invalid("结束时间不能早于开始时间。"));
                }
            }
        }
        Ok(())
    }
}
fn validate_month_or_date(date: &str) -> Result<()> {
    let full = if date.len() == 7 {
        format!("{date}-01")
    } else {
        date.into()
    };
    chrono::NaiveDate::parse_from_str(&full, "%Y-%m-%d")
        .map_err(|_| AppError::invalid("日期请使用 YYYY-MM 或 YYYY-MM-DD；未知日期可留空。"))?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileVersion {
    pub id: String,
    pub profile_id: String,
    pub created_at: String,
    pub data: ProfileData,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub current_version_id: String,
    pub versions: Vec<ProfileVersion>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    Saved,
    Pending,
    Applied,
    Assessment,
    Interview,
    Offer,
    Closed,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum EndReason {
    Rejected,
    Withdrawn,
    Joined,
}
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JobData {
    pub company: String,
    pub title: String,
    #[serde(default)]
    pub channel: String,
    #[serde(default)]
    pub batch: String,
    #[serde(default)]
    pub job_code: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub jd: String,
}
impl JobData {
    pub fn validate(&self) -> Result<()> {
        text(&self.company, "公司", true, 300)?;
        text(&self.title, "岗位", true, 300)?;
        text(&self.jd, "岗位描述", false, MAX_TEXT)?;
        for value in [&self.channel, &self.batch, &self.job_code] {
            text(value, "渠道或岗位编号", false, 500)?;
        }
        if !self.url.is_empty() {
            let url = reqwest::Url::parse(&self.url)
                .map_err(|_| AppError::invalid("岗位链接格式不正确。"))?;
            if !matches!(url.scheme(), "http" | "https") {
                return Err(AppError::invalid("岗位链接仅支持 HTTP 或 HTTPS。"));
            }
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JobSnapshot {
    pub id: String,
    pub created_at: String,
    pub data: JobData,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Application {
    pub id: String,
    pub job_snapshot_id: String,
    pub profile_version_id: Option<String>,
    pub stage: Stage,
    pub end_reason: Option<EndReason>,
    pub confirmed_submitted_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub revision: u64,
    pub next_action: String,
    pub due_at: Option<String>,
    pub notes: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplicationEvent {
    pub id: String,
    pub application_id: String,
    pub operation_id: String,
    pub kind: String,
    pub occurred_at: String,
    pub recorded_at: String,
    pub source: String,
    pub job_snapshot_id: String,
    pub profile_version_id: Option<String>,
    pub detail: serde_json::Value,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InterviewRound {
    pub id: String,
    pub application_id: String,
    pub title: String,
    pub scheduled_at: String,
    pub location: String,
    pub notes: String,
    pub completed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum AssetKind {
    Resume,
    Audio,
    Source,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum AssetStatus {
    Available,
    Missing,
    Cleaned,
    ExcludedByUser,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileAsset {
    pub id: String,
    pub kind: AssetKind,
    pub name: String,
    pub sha256: String,
    pub bytes: u64,
    pub status: AssetStatus,
    pub created_at: String,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Purpose {
    Chat,
    Asr,
}
impl Purpose {
    pub fn key(self) -> &'static str {
        match self {
            Self::Chat => "chat",
            Self::Asr => "asr",
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderConfig {
    pub purpose: Purpose,
    pub name: String,
    pub endpoint: String,
    pub model: String,
    pub version: String,
}
impl ProviderConfig {
    pub fn validate(&self) -> Result<()> {
        text(&self.name, "服务名称", true, 150)?;
        text(&self.model, "模型名称", true, 200)?;
        let url = reqwest::Url::parse(&self.endpoint)
            .map_err(|_| AppError::invalid("接口地址须为完整 URL。"))?;
        let local = matches!(
            url.host_str(),
            Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
        );
        if (url.scheme() != "https" && !(url.scheme() == "http" && local))
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(AppError::invalid(
                "接口须使用 HTTPS（本机服务可用 HTTP），地址中不能包含凭证、查询参数或片段。",
            ));
        }
        text(&self.endpoint, "接口地址", true, 2048)
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Usage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
    pub audio_seconds: Option<f64>,
    pub cost: Option<f64>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VersionRef {
    pub kind: String,
    pub id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskInput {
    pub purpose: Purpose,
    pub context_id: String,
    pub text: String,
    pub asset_id: Option<String>,
    pub stream: bool,
    pub versions: Vec<VersionRef>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelTask {
    pub id: String,
    pub context_id: String,
    pub generation: String,
    pub dataset_id: String,
    pub purpose: Purpose,
    pub provider: ProviderConfig,
    pub versions: Vec<VersionRef>,
    pub input: TaskInput,
    pub status: String,
    pub progress: String,
    pub content: String,
    pub usage: Usage,
    pub error: Option<AppError>,
    pub started_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Mutation {
    SaveProfile {
        profile_id: Option<String>,
        expected_version_id: Option<String>,
        name: String,
        data: ProfileData,
    },
    CopyProfile {
        version_id: String,
        name: String,
    },
    CreateApplication {
        job: JobData,
        profile_version_id: Option<String>,
        stage: Stage,
        duplicate_acknowledged: bool,
    },
    UpdateApplication {
        id: String,
        expected_revision: u64,
        job: JobData,
        profile_version_id: Option<String>,
        stage: Stage,
        end_reason: Option<EndReason>,
        next_action: String,
        due_at: Option<String>,
        notes: String,
    },
    ConfirmSubmitted {
        id: String,
        expected_revision: u64,
        confirmed: bool,
        submitted_at: String,
    },
    SaveInterview {
        id: Option<String>,
        application_id: String,
        expected_revision: u64,
        title: String,
        scheduled_at: String,
        location: String,
        notes: String,
        completed: bool,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub contract_version: u32,
    pub schema_version: u32,
    pub dataset_id: String,
    pub revision: u64,
    pub profiles: Vec<Profile>,
    pub jobs: Vec<JobSnapshot>,
    pub applications: Vec<Application>,
    pub events: Vec<ApplicationEvent>,
    pub interviews: Vec<InterviewRound>,
    pub assets: Vec<FileAsset>,
    pub providers: Vec<ProviderConfig>,
    pub tasks: Vec<ModelTask>,
}
