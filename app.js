// ============================================================
// 日程工作台 - 前端逻辑（Supabase 云端版）
// 数据存在云端数据库 Supabase，手机随时随地登录都能看到同一份数据
// 用原生 JS 写，不引框架，方便你读懂和日后自己改
// ============================================================

// 创建 Supabase 客户端（CONFIG 来自 config.js）
const sb = supabase.createClient(CONFIG.url, CONFIG.anonKey);

// 课程列表缓存（给作业/资料的"所属课程"下拉框用）
let courses = [];

// ---- 通用工具 ----
function shortDate(s) { return s ? s.slice(0, 10) : ''; }
function courseName(id) {
  if (!id) return '';
  const c = courses.find(x => x.id === Number(id));
  return c ? c.name : '';
}
// 防 XSS：把特殊字符转义后再插入 HTML
function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}
// 简易错误提示
function showErr(e, prefix) {
  console.error(prefix, e);
  alert((prefix || '') + (e && e.message ? e.message : e));
}

// ============================================================
// 登录 / 注册 / 退出
// ============================================================
document.getElementById('signInBtn').addEventListener('click', doSignIn);
document.getElementById('signUpBtn').addEventListener('click', doSignUp);
document.getElementById('logoutBtn').addEventListener('click', async () => {
  await sb.auth.signOut();
  document.body.classList.remove('logged-in');
  document.getElementById('loginMsg').textContent = '';
});

async function doSignIn() {
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  const msg = document.getElementById('loginMsg');
  msg.textContent = '登录中…';
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) { msg.textContent = error.message; return; }
  msg.textContent = '';
  enterApp();
}

async function doSignUp() {
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  const msg = document.getElementById('loginMsg');
  if (password.length < 6) { msg.textContent = '密码至少 6 位'; return; }
  msg.textContent = '注册中…';
  const { data, error } = await sb.auth.signUp({ email, password });
  if (error) { msg.textContent = error.message; return; }
  if (data.session) {
    // 未开邮箱确认时，注册完即登录
    msg.textContent = '';
    enterApp();
  } else {
    msg.textContent = '注册成功！请去邮箱点确认链接，回来再点登录。';
  }
}

// 进入主界面
function enterApp() {
  document.body.classList.add('logged-in');
  loadDashboard();
}

// 页面打开时检查是否已登录（session 还在就免登录）
async function initAuth() {
  const { data } = await sb.auth.getSession();
  if (data.session) enterApp();
}
initAuth();

// ============================================================
// 标签页切换
// ============================================================
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    const page = btn.dataset.page;
    document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + page));
    if (page === 'dashboard') loadDashboard();
    if (page === 'homework') loadHomework();
    if (page === 'courses') loadCourses();
    if (page === 'materials') loadMaterials();
    if (page === 'chores') loadChores();
  });
});

// ============================================================
// 工作台：一次性拉取作业/琐事/课程，算出今日概览
// ============================================================
async function loadDashboard() {
  const today = new Date().toISOString().slice(0, 10);

  const [{ data: hw }, { data: ch }, { data: co }] = await Promise.all([
    sb.from('homework').select('*'),
    sb.from('chores').select('*'),
    sb.from('courses').select('*')
  ]);

  const homework = hw || [];
  const chores = ch || [];
  const courseList = co || [];

  // 统计卡片
  const sc = document.getElementById('statCards');
  sc.innerHTML = `
    <div class="stat-card"><div class="num">${homework.filter(h => !h.done).length}</div><div class="lbl">未完成作业</div></div>
    <div class="stat-card"><div class="num">${courseList.length}</div><div class="lbl">课程数</div></div>
    <div class="stat-card"><div class="num">${chores.length}</div><div class="lbl">琐事总数</div></div>
  `;

  // 今日到期作业
  const dueHw = homework.filter(h => !h.done && h.deadline && h.deadline.slice(0, 10) === today);
  const dh = document.getElementById('dashHomework');
  dh.innerHTML = dueHw.length
    ? dueHw.map(h => `<li class="item"><div class="row1"><span class="title">${escapeHtml(h.title)}</span></div><div class="meta">${courseName(h.course_id) ? '<span class="tag">' + escapeHtml(courseName(h.course_id)) + '</span>' : ''}截止：${escapeHtml(shortDate(h.deadline))}</div></li>`).join('')
    : '<li class="empty">今天没有到期作业，安心做别的吧</li>';

  // 今日待办琐事
  const todayChores = chores.filter(c => !c.done && c.due_date && c.due_date.slice(0, 10) === today);
  const dc = document.getElementById('dashChores');
  dc.innerHTML = todayChores.length
    ? todayChores.map(c => `<li class="item"><div class="row1"><span class="title">${escapeHtml(c.title)}</span></div><div class="meta">待办：${escapeHtml(shortDate(c.due_date))}</div></li>`).join('')
    : '<li class="empty">今天没有待办琐事</li>';
}

// ============================================================
// 课程管理
// ============================================================
async function loadCourses() {
  const { data, error } = await sb.from('courses').select('*').order('created_at', { ascending: false });
  if (error) return showErr(error, '加载课程失败：');
  courses = data || [];
  fillCourseSelects();

  const list = document.getElementById('courseList');
  list.innerHTML = courses.length
    ? courses.map(c => `
      <li class="item">
        <div class="row1">
          <span class="title">${escapeHtml(c.name)}</span>
          <div class="ops">
            <button class="btn-del" onclick="delCourse(${c.id})">删除</button>
          </div>
        </div>
        <div class="meta">
          ${c.teacher ? '教师：' + escapeHtml(c.teacher) + '<br>' : ''}
          ${c.location ? '地点：' + escapeHtml(c.location) + '<br>' : ''}
          ${c.class_time ? '时间：' + escapeHtml(c.class_time) + '<br>' : ''}
          ${c.requirement ? '要求：' + escapeHtml(c.requirement) + '<br>' : ''}
          ${c.note ? '备注：' + escapeHtml(c.note) : ''}
        </div>
      </li>`).join('')
    : '<li class="empty">还没有课程，点上方"+ 添加课程"开始</li>';
}

document.getElementById('courseForm').addEventListener('submit', async e => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  const { error } = await sb.from('courses').insert(body);
  if (error) return showErr(error, '保存失败：');
  e.target.reset();
  loadCourses();
});

async function delCourse(id) {
  if (!confirm('确定删除这门课程？')) return;
  const { error } = await sb.from('courses').delete().eq('id', id);
  if (error) return showErr(error, '删除失败：');
  loadCourses();
}

// ============================================================
// 作业管理
// ============================================================
async function loadHomework() {
  if (!courses.length) {
    const { data } = await sb.from('courses').select('*');
    courses = data || [];
  }
  fillCourseSelects();

  const { data, error } = await sb.from('homework').select('*').order('created_at', { ascending: false });
  if (error) return showErr(error, '加载作业失败：');
  const list = data || [];

  const ul = document.getElementById('hwList');
  list.sort((a, b) => (a.done - b.done) || (a.deadline || '').localeCompare(b.deadline || ''));
  ul.innerHTML = list.length
    ? list.map(h => `
      <li class="item ${h.done ? 'is-done' : ''}">
        <div class="row1">
          <span class="title ${h.done ? 'done' : ''}">${escapeHtml(h.title)}</span>
          <div class="ops">
            <button class="btn-done ${h.done ? 'is-done' : ''}" onclick="toggleHw(${h.id}, ${!h.done})">${h.done ? '已做' : '完成'}</button>
            <button class="btn-del" onclick="delHw(${h.id})">删除</button>
          </div>
        </div>
        <div class="meta">
          ${courseName(h.course_id) ? '<span class="tag">' + escapeHtml(courseName(h.course_id)) + '</span>' : ''}
          ${h.deadline ? '截止：' + escapeHtml(h.deadline) : ''}
        </div>
      </li>`).join('')
    : '<li class="empty">没有作业记录</li>';
}

document.getElementById('hwForm').addEventListener('submit', async e => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  body.done = false;
  if (body.course_id === '') delete body.course_id;
  else body.course_id = Number(body.course_id);
  if (body.deadline === '') delete body.deadline;
  const { error } = await sb.from('homework').insert(body);
  if (error) return showErr(error, '保存失败：');
  e.target.reset();
  loadHomework();
});

async function toggleHw(id, done) {
  const { error } = await sb.from('homework').update({ done }).eq('id', id);
  if (error) return showErr(error, '更新失败：');
  loadHomework();
}
async function delHw(id) {
  if (!confirm('确定删除这条作业？')) return;
  const { error } = await sb.from('homework').delete().eq('id', id);
  if (error) return showErr(error, '删除失败：');
  loadHomework();
}

// ============================================================
// 学习资料
// ============================================================
async function loadMaterials() {
  if (!courses.length) {
    const { data } = await sb.from('courses').select('*');
    courses = data || [];
  }
  fillCourseSelects();

  const { data, error } = await sb.from('materials').select('*').order('created_at', { ascending: false });
  if (error) return showErr(error, '加载资料失败：');
  const list = data || [];

  const ul = document.getElementById('matList');
  ul.innerHTML = list.length
    ? list.map(m => `
      <li class="item">
        <div class="row1">
          <span class="title">${escapeHtml(m.name)}</span>
          <div class="ops">
            <button class="btn-del" onclick="delMat(${m.id})">删除</button>
          </div>
        </div>
        <div class="meta">
          <span class="tag">${escapeHtml(m.type || '其他')}</span>
          ${courseName(m.course_id) ? '<span class="tag">' + escapeHtml(courseName(m.course_id)) + '</span>' : ''}
          ${m.location ? '位置：' + escapeHtml(m.location) + '<br>' : ''}
          ${m.note ? '备注：' + escapeHtml(m.note) : ''}
        </div>
      </li>`).join('')
    : '<li class="empty">没有资料记录</li>';
}

document.getElementById('matForm').addEventListener('submit', async e => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  if (body.course_id === '') delete body.course_id;
  else body.course_id = Number(body.course_id);
  const { error } = await sb.from('materials').insert(body);
  if (error) return showErr(error, '保存失败：');
  e.target.reset();
  loadMaterials();
});

async function delMat(id) {
  if (!confirm('确定删除这条资料？')) return;
  const { error } = await sb.from('materials').delete().eq('id', id);
  if (error) return showErr(error, '删除失败：');
  loadMaterials();
}

// ============================================================
// 日常琐事
// ============================================================
async function loadChores() {
  const { data, error } = await sb.from('chores').select('*').order('created_at', { ascending: false });
  if (error) return showErr(error, '加载琐事失败：');
  const list = data || [];

  const ul = document.getElementById('choreList');
  list.sort((a, b) => (a.done - b.done) || (a.due_date || '').localeCompare(b.due_date || ''));
  ul.innerHTML = list.length
    ? list.map(c => `
      <li class="item ${c.done ? 'is-done' : ''}">
        <div class="row1">
          <span class="title ${c.done ? 'done' : ''}">${escapeHtml(c.title)}</span>
          <div class="ops">
            <button class="btn-done ${c.done ? 'is-done' : ''}" onclick="toggleChore(${c.id}, ${!c.done})">${c.done ? '已做' : '完成'}</button>
            <button class="btn-del" onclick="delChore(${c.id})">删除</button>
          </div>
        </div>
        <div class="meta">${c.due_date ? '待办：' + escapeHtml(shortDate(c.due_date)) : ''}</div>
      </li>`).join('')
    : '<li class="empty">没有琐事记录</li>';
}

document.getElementById('choreForm').addEventListener('submit', async e => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  body.done = false;
  if (body.due_date === '') delete body.due_date;
  const { error } = await sb.from('chores').insert(body);
  if (error) return showErr(error, '保存失败：');
  e.target.reset();
  loadChores();
});

async function toggleChore(id, done) {
  const { error } = await sb.from('chores').update({ done }).eq('id', id);
  if (error) return showErr(error, '更新失败：');
  loadChores();
}
async function delChore(id) {
  if (!confirm('确定删除这条琐事？')) return;
  const { error } = await sb.from('chores').delete().eq('id', id);
  if (error) return showErr(error, '删除失败：');
  loadChores();
}

// ============================================================
// 给作业、资料表单的"所属课程"下拉框填充选项
// ============================================================
function fillCourseSelects() {
  const opts = '<option value="">（无）</option>' +
    courses.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  document.querySelectorAll('select[name="course_id"]').forEach(sel => {
    const cur = sel.value;
    sel.innerHTML = opts;
    sel.value = cur;
  });
}
