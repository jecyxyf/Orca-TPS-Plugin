const escape = value => String(value ?? '').replace(/[&<>"']/g, part =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[part]);
const date = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
});
const timeElement = value => `<time datetime="${new Date(value).toISOString()}">${date.format(value)} 北京时间</time>`;
export const localTimes = `
  const clock = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  for (const time of document.querySelectorAll('time[datetime]')) time.textContent = clock.format(new Date(time.dateTime));
`;

function layout(content, title = '天梯榜管理') {
  return `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>
:root{color-scheme:light;--ink:#182832;--paper:#f1f5f8;--line:#c9d6df;--accent:#184e70;--danger:#992d39}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.55 system-ui,sans-serif}
main{max-width:1040px;margin:auto;padding:clamp(1rem,4vw,3.5rem)}h1{font-size:clamp(2rem,6vw,3.25rem);margin:0;line-height:1.15;letter-spacing:-.045em}
h2{font-size:1.25rem;margin:0}p{margin:.5rem 0}header{display:flex;justify-content:space-between;gap:1rem;align-items:start;border-top:5px solid var(--accent);padding:1.3rem 0}
section{padding:1.2rem 0;border-top:1px solid var(--line)}form.filters{display:flex;align-items:end;gap:.65rem;flex-wrap:wrap;margin:.85rem 0}
label{display:grid;gap:.25rem}input,button,a.button{font:inherit;border-radius:4px;padding:.4rem .65rem}
button,a.button{background:white;border:1px solid var(--accent);color:var(--accent);cursor:pointer;text-decoration:none}
.primary{color:white!important;background:var(--accent)!important}.danger{color:var(--danger);border-color:var(--danger)}
input{border:1px solid var(--line);background:white;color:var(--ink);min-width:0}a:focus-visible,button:focus-visible,input:focus-visible{outline:3px solid #1782bf;outline-offset:3px}
.scroll{overflow:auto}table{border-collapse:collapse;width:100%;min-width:330px}th,td{text-align:left;padding:.55rem .35rem;border-bottom:1px solid var(--line)}
.action{text-align:right}.muted{color:#4b6474}.notice{padding:.6rem .8rem;background:#e0eef6;border-left:4px solid var(--accent)}
.account-table{min-width:510px}.ban-reason{max-width:18rem;overflow-wrap:anywhere}.ban-form{display:flex;justify-content:flex-end;align-items:center;gap:.4rem}
.ban-form input{width:9rem}
.empty{padding:.8rem 0}
</style><main>${content}</main><script src="/admin/local-time.js" defer></script></html>`;
}

export function pluginLoginResult(message) {
  return layout(`<header><h1>TPS Plugin</h1></header><section><p role="status">${escape(message)}</p></section>`, 'TPS Plugin GitHub 登录');
}

export function adminLogin(message = '', available = true) {
  return layout(`<header><h1>天梯榜管理</h1></header><section>
    ${message ? `<p class="notice" role="status">${escape(message)}</p>` : ''}
    ${available ? '<p>使用管理员 GitHub 账号登录。</p><p><a class="button primary" href="/auth/github/start">用 GitHub 登录</a></p>' : '<p>GitHub 登录正在配置。</p>'}
  </section>`);
}

export function adminPage({ search, username, accounts, audit, feedback }) {
  const accountRows = accounts.map(row => {
    const status = row.banned ? '已封禁' : '正常';
    const reason = row.banned ? escape(row.reason ?? '未记录') : '—';
    return `<tr><td>${escape(row.username)}</td><td>${status}</td>
    <td class="ban-reason">${reason}</td>
    <td class="action"><form class="ban-form" method="post" action="/admin/ban">
    <input type="hidden" name="q" value="${escape(search)}"><input type="hidden" name="account" value="${row.id}">
    ${row.banned ? '' : '<input name="reason" required maxlength="200" aria-label="封禁原因" placeholder="填写封禁原因">'}
    <button ${row.banned ? '' : 'class="danger"'} type="submit" name="ban" value="${row.banned ? '0' : '1'}">${row.banned ? '解封' : '封禁'}</button></form></td></tr>`;
  }).join('');
  const auditRows = audit.map(row => `<tr><td>${timeElement(row.at)}</td><td>${escape(row.username)}</td>
    <td>${row.action === 'ban' ? '封禁' : '解封'}</td>
    <td>${escape(row.target)}</td></tr>`).join('');
  return layout(`<header><div><h1>天梯榜管理</h1><p class="muted">${escape(username)}</p></div>
    <form method="post" action="/admin/logout"><button type="submit">退出</button></form></header>
    ${feedback ? `<p class="notice" role="status">${escape(feedback)}</p>` : ''}
    <section><h2>GitHub 账号</h2>
    <form class="filters" action="/admin">
    <label>GitHub 用户名<input name="q" value="${escape(search)}" maxlength="39"></label><button class="primary">查询</button></form>
    ${accountRows ? `<div class="scroll"><table class="account-table"><thead><tr><th>账号</th><th>状态</th><th>限制原因</th><th class="action">操作</th></tr></thead><tbody>${accountRows}</tbody></table></div>` : '<p class="empty muted">没有符合条件的账号。</p>'}</section>
    <section><h2>最近管理操作</h2>${auditRows ? `<div class="scroll"><table><thead><tr><th>时间</th><th>管理员</th><th>操作</th><th>范围</th></tr></thead><tbody>${auditRows}</tbody></table></div>` : '<p class="empty muted">暂无操作记录。</p>'}</section>`);
}
