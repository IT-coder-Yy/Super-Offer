const normalize = (value) =>
  String(value || "")
    .replace(/[\s:：*＊✱()（）/]/g, "")
    .toLowerCase();
const aliases = {
  basic: {
    name: ["姓名", "真实姓名", "中文名", "name", "fullname"],
    phone: ["手机", "手机号", "手机号码", "联系电话", "电话", "phone", "tel"],
    email: ["邮箱", "电子邮箱", "email"],
    city: ["现居城市", "现居地", "所在地"],
    hometown: ["籍贯"],
    birthDate: ["出生日期", "生日"],
    gender: ["性别"],
    politicalStatus: ["政治面貌"],
    website: ["个人主页", "个人网站"],
    github: ["github"],
  },
  education: {
    school: ["学校", "学校名称", "毕业院校", "院校"],
    major: ["专业", "专业名称"],
    degree: ["学历", "学位"],
    startDate: ["开始时间", "入学时间", "入学日期"],
    endDate: ["结束时间", "毕业时间", "毕业日期"],
    gpa: ["gpa", "成绩", "绩点"],
    ranking: ["排名", "专业排名"],
    courses: ["课程", "主修课程", "相关课程"],
    description: ["校园经历", "在校经历"],
  },
  experience: {
    company: ["公司", "公司名称", "单位名称"],
    title: ["岗位", "职位", "职位名称"],
    type: ["经历类型", "工作类型"],
    startDate: ["开始时间", "入职时间", "开始日期"],
    endDate: ["结束时间", "离职时间", "结束日期"],
    responsibilities: ["职责", "工作职责", "工作内容"],
    achievements: ["成果", "工作成果", "业绩"],
  },
  projects: {
    name: ["项目名称"],
    role: ["项目角色", "担任角色"],
    startDate: ["开始时间", "开始日期"],
    endDate: ["结束时间", "结束日期"],
    technology: ["技术栈", "使用技术"],
    url: ["项目链接", "项目地址"],
    description: ["项目介绍", "项目描述"],
    contribution: ["个人贡献", "本人贡献"],
    results: ["项目成果"],
  },
  skills: {
    technical: ["技术技能", "专业技能"],
    languages: ["语言能力", "外语水平"],
  },
  certificates: {
    name: ["证书", "证书名称", "奖励名称"],
    issuer: ["颁发机构", "发证机构"],
    date: ["获得时间", "颁发时间"],
    description: ["证书说明", "奖励说明"],
  },
  intentions: {
    roles: ["目标岗位", "意向岗位", "期望岗位", "求职意向"],
    cities: ["目标城市", "期望城市", "意向城市", "工作地点"],
    salary: ["期望薪资", "薪资要求"],
    availableFrom: ["到岗时间", "可入职时间"],
  },
};
const groupWords = {
  education: /教育|学历|education/i,
  experience: /工作|实习|职业|employment|experience/i,
  projects: /项目|project/i,
  certificates: /证书|奖励|certificate/i,
  skills: /技能|语言|skill/i,
  intentions: /意向|求职|期望/i,
};
export const otherPerson = /联系人|联络人|推荐人|证明人|监护人|家庭成员|emergency[\s_-]*contact|\b(?:referees?|references?)\b/i;
export const repeated = new Set([
  "education",
  "experience",
  "projects",
  "certificates",
]);
export function inferMappings(fields) {
  const entries = new Map();
  const mapped = fields.map((field) => {
    if (field.type === "file")
      return { ...field, path: null, reason: field.resumeUpload ? "使用档案的配套简历" : "未确认是简历上传入口，请本人核对附件用途" };
    if (["custom-select", "composite"].includes(field.type))
      return { ...field, path: null, reason: "自定义选项或复合控件请本人操作，不向内部输入框写入资料" };
    if (otherPerson.test(field.label) || otherPerson.test(field.section))
      return { ...field, path: null, reason: "此处涉及其他人的资料，请本人核对" };
    let group = Object.keys(groupWords).find((g) =>
      groupWords[g].test(field.section),
    );
    const name = normalize(field.label);
    const candidates = [];
    if (name === "描述" && group === "projects" && field.type === "textarea" &&
        field.entryId && Number.isInteger(field.entryIndex) && field.entryIndex >= 0)
      candidates.push({ group: "projects", key: "description" });
    for (const [owner, keys] of Object.entries(aliases))
      for (const [key, names] of Object.entries(keys))
        if (
          (!group || group === owner) &&
          names.some((x) => normalize(x) === name)
        )
          candidates.push({ group: owner, key });
    // autocomplete 描述数据类型；明确的题目或经历区块优先于这个提示。
    if (!candidates.length && !group && field.autocomplete &&
        (field.hasCaption === false || name === normalize(field.autocomplete) || /^(?:请输入|请填写|请选择)$/.test(name))) {
      const key = {
        name: "name",
        email: "email",
        tel: "phone",
        bday: "birthDate",
        sex: "gender",
      }[field.autocomplete];
      if (key) candidates.push({ group: "basic", key });
    }
    if (candidates.length !== 1)
      return {
        ...field,
        path: null,
        reason: "字段语义不明确，需要匹配或人工处理",
      };
    const item = candidates[0];
    group = item.group;
    const groupEntries = entries.get(group) || [];
    entries.set(group, groupEntries);
    const entryId = field.entryId || "unmarked";
    if (!groupEntries.includes(entryId)) groupEntries.push(entryId);
    if (repeated.has(group) && field.entryIndex === -1)
      return { ...field, path: null, reason: "无法确认重复经历所属模块，请人工核对" };
    const index = Number.isInteger(field.entryIndex) && field.entryIndex >= 0
      ? field.entryIndex : groupEntries.indexOf(entryId);
    const path = repeated.has(group)
      ? `${group}.${index}.${item.key}`
      : `${group}.${item.key}`;
    return { ...field, path, group, index, reason: "" };
  });
  for (const field of mapped)
    if (field.path && repeated.has(field.group)) {
      if (mapped.filter((x) => x.path === field.path).length > 1) {
        for (const other of mapped.filter((x) => x.path === field.path)) {
          other.reason = "无法确认重复经历的条目边界，请人工核对";
          other.path = null;
        }
      }
    }
  return mapped;
}
export function readValue(data, path) {
  if (
    !path ||
    !/^(basic|education|experience|projects|skills|certificates|intentions|answers)\.[\w.]+$/.test(
      path,
    )
  )
    return null;
  const keys = path.split(".");
  let value = data;
  for (const key of keys) value = value?.[key];
  if (keys[0] === "intentions" && keys.length === 2) {
    const legacy = { roles: "role", cities: "city", availableFrom: "availableDate" }[keys[1]];
    // 仅旧档案缺少当前字段时兼容旧键；本人清空后不取回过期内容。
    if (legacy && !Object.hasOwn(data?.intentions ?? {}, keys[1]))
      value = data?.intentions?.[legacy];
  }
  return typeof value === "string" && value.trim() ? value : null;
}
export const addLabels = {
  education: ["新增教育经历", "添加教育经历", "添加教育"],
  experience: ["新增工作经历", "添加工作经历", "新增实习经历", "添加实习经历"],
  projects: ["新增项目经历", "添加项目经历", "添加项目"],
  certificates: ["新增证书", "添加证书", "添加奖励"],
};
