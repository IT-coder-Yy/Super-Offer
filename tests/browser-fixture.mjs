import http from "node:http";
export const profile = (name = "合成甲") => ({
  id: name,
  name,
  data: {
    basic: {
      name,
      phone: "13900000000",
      email: "fixture@example.invalid",
      gender: "女",
      birthDate: "2000-01",
      github: "https://example.invalid/code",
    },
    education: [
      {
        school: "样本大学",
        major: "计算机",
        degree: "本科",
        startDate: "2020-09",
        endDate: "2024-06",
      },
      {
        school: "样本研究院",
        major: "软件工程",
        degree: "硕士",
        startDate: "2024-09",
      },
    ],
    experience: [],
    projects: [],
    skills: {},
    certificates: [],
    intentions: { roles: "合成开发岗位", cities: "杭州", availableFrom: "2026-12-01" },
    answers: [],
    resumeAssetId: null,
  },
  attachment: null,
});
export async function fixture() {
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    const step2 = req.url?.startsWith("/step2");
    const edu =
      '<fieldset data-section="教育经历"><legend>教育经历</legend><label>学校<input name="school"></label><label>专业<input name="major"></label><label>学历<select name="degree"><option value=""></option><option value="bachelor">本科</option><option value="master">硕士</option></select></label><label>开始时间<input type="month" name="start"></label><label>结束时间<input type="month" name="end"></label></fieldset>';
    res.end(
      `<!doctype html><html lang="zh"><meta charset="utf-8"><title>受控完整申请样本</title><style>body{padding:24px;font:16px sans-serif;max-width:800px}label{display:block;margin:10px}input,select,textarea{display:block;margin:4px;width:260px}fieldset{margin:20px 0}button{margin:8px}</style><form onsubmit="window.submissions++;return false">${step2 ? '<fieldset><legend>基本信息</legend><label>GitHub<input id="tail"></label></fieldset><button type="submit">最终提交申请</button>' : `<fieldset><legend>基本信息</legend><label>姓名<input id="name" required></label><label>手机<input id="phone" disabled></label><label>邮箱<input id="email" type="email"></label><label>出生日期<input id="birth" type="date"></label><label>性别<select id="gender"><option value=""></option><option value="f">女</option><option value="m">男</option></select></label></fieldset><section id="education"><h2>教育经历</h2>${edu}<button id="add" type="button">新增教育经历</button></section><fieldset><legend>求职意向</legend><label>意向城市<select id="city"><option value=""></option><option>北京</option></select></label></fieldset><fieldset><legend>附件</legend><label>简历附件<input type="file" id="resume" accept=".pdf"></label><span id="upload-result"></span></fieldset><div style="height:500px"></div><label>GitHub<input id="tail"></label><label>为何选择此岗位<textarea id="answer"></textarea></label><button id="save" type="button">保存草稿</button><button id="next" type="button">下一步</button><button type="submit">最终提交申请</button>`}</form><script>window.submissions=0;window.saved=0;document.querySelector('#add')?.addEventListener('click',()=>document.querySelector('#add').insertAdjacentHTML('beforebegin',${JSON.stringify(edu)}));document.querySelector('#next')?.addEventListener('click',()=>location.href='/step2');document.querySelector('#save')?.addEventListener('click',()=>window.saved++);document.querySelector('#resume')?.addEventListener('change',()=>document.querySelector('#upload-result').textContent=window.failUpload?'上传失败':'上传成功');</script></html>`,
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
