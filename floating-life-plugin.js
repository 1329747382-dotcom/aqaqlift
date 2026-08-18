/**
 * 浮生 (FloatingLife) - Roche 全信任 JS 插件 v2.0
 * 一场醒来就忘的梦
 * UI 还原自 Echoes v4 浮生功能
 *
 * v2.0 更新：
 * - 修复顶部白边与布局溢出
 * - UI 全面还原原件风格（分类列表式、精致卡片）
 * - 世界书改为用户自主选取
 * - 修复选项栏目无法回收的 bug
 * - 修复 !== 语法错误
 */
(function () {
  'use strict';
  const STORAGE_KEY = 'floating_life_sessions';
  const SUMMARY_THRESHOLD = 16;
  const SUMMARY_KEEP_LAST = 8;

  // ========== 工具函数 ==========
  function extractJSON(text) {
    if (!text) return text;
    let t = text.replace(/<think(?:ing)?[\s\S]*?<\/think(?:ing)?>/gi, '');
    t = t.replace(/```json/gi, '').replace(/```/g, '');
    let pos = 0, firstMatch = null;
    while (pos < t.length) {
      const bi = t.indexOf('{', pos), ki = t.indexOf('[', pos);
      let start = -1, open, close;
      if (bi >= 0 && (ki < 0 || bi < ki)) { start = bi; open = '{'; close = '}'; }
      else if (ki >= 0) { start = ki; open = '['; close = ']'; }
      else break;
      let depth = 0, inStr = false, esc = false, end = -1;
      for (let i = start; i < t.length; i++) {
        const ch = t[i];
        if (esc) { esc = false; continue; }
        if (ch === '\\' && inStr) { esc = true; continue; }
        if (ch === '"') { inStr = !inStr; continue; }
        if (!inStr) {
          if (ch === open) depth++;
          else if (ch === close) { depth--; if (depth === 0) { end = i; break; } }
        }
      }
      if (end < 0) break;
      const cand = t.slice(start, end + 1);
      if (firstMatch === null) firstMatch = cand;
      try { JSON.parse(cand); return cand; } catch (e) { pos = end + 1; }
    }
    return firstMatch ?? t.trim();
  }

  function safeParseJSON(text, context) {
    try { return JSON.parse(text); }
    catch (e) {
      try { return JSON.parse(extractJSON(text)); }
      catch (e2) { throw new Error(`浮生：${context}返回的内容无法解析为 JSON`); }
    }
  }

  function getPerspectiveText(perspective, userName, userGender) {
    const pronoun = (userGender === '男' || userGender === '男性') ? '他' : '她';
    switch (perspective) {
      case 'second-person': return '使用第二人称叙事，称呼用户为「你」。';
      case 'first-person': return '使用第一人称叙事，称呼角色自己为「我」，让读者代入该角色。';
      default: return `使用第三人称有限视角叙事，称呼用户角色为「${userName}」或「${pronoun}」。`;
    }
  }

  function formatWorldBooks(worldBooks, selectedIds) {
    const selected = (worldBooks || []).filter(w => selectedIds.includes(w.id));
    if (selected.length === 0) return '';
    return '【用户选取的世界书】\n' + selected.map(w =>
      `[${w.title || w.name || '未命名'}]（类型：${w.categoryId || w.category || '未知'}）\n${w.content || w.text || ''}`
    ).join('\n');
  }

  function formatCharactersInfo(characters, worldBooks, selectedWBIds) {
    return (characters || []).map(char => {
      const lines = [`名字：${char.name || char.handle || '未知'}`];
      if (char.gender) lines.push(`性别：${char.gender}`);
      if (char.bio) lines.push(`简介：${char.bio}`);
      const personaText = char.persona || char.background || char.description || '';
      const mountedIds = new Set(char.mountedWorldBookIds || char.worldBookIds || []);
      // 角色挂载的世界书也需要在用户选取范围内才生效
      const lore = (worldBooks || []).filter(w =>
        (w.categoryId === 'lore' || w.category === 'lore') &&
        mountedIds.has(w.id) &&
        selectedWBIds.includes(w.id)
      );
      if (lore.length > 0) { lines.push('补充背景知识：'); lore.forEach(w => lines.push(`- ${w.title || w.name}：${w.content || w.text}`)); }
      if (personaText) lines.push(`人设：${personaText}`);
      const patches = (worldBooks || []).filter(w =>
        (w.categoryId === 'patch' || w.category === 'patch') &&
        mountedIds.has(w.id) &&
        selectedWBIds.includes(w.id)
      );
      if (patches.length > 0) { lines.push('灵魂补丁：'); patches.forEach(w => lines.push(`- ${w.title || w.name}：${w.content || w.text}`)); }
      return lines.join('\n');
    }).join('\n---\n');
  }

  function buildContext(worldSetting, messages, summaries, characters, user, keepLast, worldBooks, selectedWBIds) {
    const parts = [];
    const wbText = formatWorldBooks(worldBooks, selectedWBIds);
    if (wbText) parts.push(wbText);
    parts.push(`【世界观】\n场景：${worldSetting.scene || ''}\n冲突种子：${worldSetting.conflictSeed || ''}\n氛围关键词：${(worldSetting.keywords || []).join('、')}\n暗线：${worldSetting.hiddenArc || ''}`);
    const roleLines = Object.entries(worldSetting.characterRoles || {}).map(([id, role]) => {
      const char = (characters || []).find(c => c.id === id);
      const name = (char && (char.name || char.handle)) || id;
      const originTrait = (char && (char.persona || char.background)) ? `（原始性格特征：${char.persona || char.background}）` : '';
      return `${name}：${role}${originTrait}`;
    });
    if (user) {
      const userOrigin = (user.persona || user.background) ? `（原始性格特征：${user.persona || user.background}）` : '';
      roleLines.unshift(`${user.name || user.handle || '用户'}（用户）：${worldSetting.userRole || ''}${userOrigin}`);
    } else { roleLines.unshift(`用户：${worldSetting.userRole || ''}`); }
    parts.push(`【角色（平行身份）】\n${roleLines.join('\n')}`);
    if (summaries && summaries.length > 0) parts.push(`【之前的故事摘要】\n${summaries.map(s => s.text).join('\n')}`);
    const recent = (messages || []).slice(-keepLast);
    if (recent.length > 0) parts.push(`【最近对话】\n${recent.map(m => m.role === 'narrator' ? `[叙述者] ${m.text}` : `[用户选择] ${m.text}`).join('\n')}`);
    return parts.join('\n');
  }

  function segmentsToText(segments) {
    return (segments || []).map(seg => {
      if (seg.type === 'narration') return seg.text;
      const action = seg.action ? `（${seg.action}）` : '';
      return `${seg.character}${action}：「${seg.text}」`;
    }).join('\n');
  }

  function stripQuotes(text) {
    let t = (text || '').trim();
    const pairs = [['「', '」'], ['『', '』'], ['"', '"'], ["'", "'"], ['"', '"'], ['‘', '’']];
    let changed = true;
    while (changed) {
      changed = false;
      for (const [open, close] of pairs) {
        if (t.startsWith(open) && t.endsWith(close) && t.length > 1) { t = t.slice(1, -1).trim(); changed = true; break; }
      }
    }
    return t;
  }

  function normalizeSegments(segments) {
    if (!Array.isArray(segments)) return [];
    return segments.map(seg => {
      if (seg.type === 'dialogue') return { type: 'dialogue', text: stripQuotes(String(seg.text || '')), character: String(seg.character || ''), action: seg.action ? String(seg.action) : undefined };
      return { type: 'narration', text: String(seg.text || '') };
    }).filter(seg => seg.text);
  }

  function normalizeChoices(choices) {
    if (!Array.isArray(choices)) return [];
    return choices.map((c, i) => ({ id: c.id ?? (i + 1), text: String(c.text || ''), tag: String(c.tag || '') }));
  }

  function generateId(prefix) { return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`; }
  function esc(text) { const d = document.createElement('div'); d.textContent = text || ''; return d.innerHTML; }

  // ========== Prompt 构建 ==========
  function buildWorldPrompt(p) {
    const userName = p.user.name || p.user.handle || '旅人';
    const charsInfo = formatCharactersInfo(p.characters, p.worldBooks, p.selectedWBIds);
    const perspText = getPerspectiveText(p.perspective, userName, p.user.gender);
    const wbText = formatWorldBooks(p.worldBooks, p.selectedWBIds);
    const charIds = (p.characters || []).map(c => c.id).join(', ');
    const wbSection = wbText ? `## 用户选取的世界书\n以下是用户主动选取的世界书条目，在构建世界观时必须遵守：\n${wbText}\n\n` : '';
    const themeSection = p.userTheme
      ? `## 用户指定题材方向（最高优先级）\n用户明确要求的题材是：「${p.userTheme}」\n你必须严格按照这个方向构建世界观。\n\n`
      : `## 题材方向\n由你自由发挥，请大胆创造有趣且出人意料的设定。\n\n`;
    return `你是「浮生」系统的世界架构师。
任务：基于下列角色的性格和人设，构建一个平行宇宙世界观，并撰写开场白。
## 角色信息
### 用户
名字：${userName}
性别：${p.user.gender || '未知'}
简介：${p.user.bio || ''}
背景：${p.user.persona || p.user.background || ''}
### AI 角色
${charsInfo}
${wbSection}${themeSection}## 叙事视角
${perspText}
## 输出要求
返回严格 JSON：
{
  "title": "世界短标题（2-6字，用·分隔）",
  "scene": "时代与场景描述（2-3句，有画面感）",
  "characterRoles": { "<角色ID>": "该角色的平行身份（1-2句）" },
  "userRole": "用户的平行身份（1-2句）",
  "conflictSeed": "核心冲突种子（1句话）",
  "keywords": ["关键词1","关键词2","关键词3"],
  "hiddenArc": "故事暗线（1-2句）",
  "openingSegments": [
    { "type": "narration", "text": "场景描写" },
    { "type": "dialogue", "character": "角色名", "text": "台词", "action": "可选动作" }
  ],
  "choices": [ { "id":1, "text":"选项", "tag":"标签" } ]
}
## 核心原则
- 角色平行身份保留原始人设核心性格，但可放到完全不同的背景
- 指定题材时严格遵守，是最高优先级
- 开场白用文学化叙事语言，自然让至少一个角色开口
- openingSegments 4-10个，总字数500-800字
- 三个选项指向不同故事方向
- characterRoles 的 key 必须用角色 ID：${charIds}`;
  }

  function buildStoryPrompt(p) {
    const userName = p.user.name || p.user.handle || '旅人';
    const ctx = buildContext(p.session.worldSetting, p.session.messages, p.session.summaries, p.characters, p.user, p.keepLast, p.worldBooks, p.selectedWBIds);
    const perspText = getPerspectiveText(p.session.perspective, userName, p.user.gender);
    const actionCount = (p.session.messages || []).filter(m => m.role === 'user').length;
    return `你是「浮生」故事的叙述者，负责推进平行宇宙剧情。
你同时扮演所有参与角色，在叙事中穿插对话和动作。
## 上下文
${ctx}
## 叙事视角
${perspText}
## 用户的行动
${p.userInput}
## 当前进度
这是用户的第 ${actionCount} 次行动。
## 输出要求
返回严格 JSON：
{
  "segments": [
    { "type": "narration", "text": "旁白" },
    { "type": "dialogue", "character": "角色名", "text": "台词", "action": "可选动作" }
  ],
  "choices": [ { "id":1, "text":"选项", "tag":"标签" } ],
  "isEnding": false
}
segments：4-10个，500-800字，自然交织旁白和对话。
isEnding：前8轮不要设true，第8轮后叙事节奏合适可设true。
## 角色扮演规则
- 扮演所有AI角色，台词行为贴合平行身份性格
- 不用每轮所有角色都出场
- 对话有性格化口吻
## 叙事优先级
1. 氛围感 2. 选项有趣 3. 角色像那个角色 4. 叙事节奏 5. 逻辑自洽
## 关键规则
- 每次只写一个场景片段
- 暗线微妙影响但不直接点破
- 不重复用户选择，直接展开后续
- 自由文本灵活接纳`;
  }

  function buildSummaryPrompt(messages, existingSummaries) {
    const existing = (existingSummaries || []).length > 0 ? `已有摘要：\n${existingSummaries.map(s => s.text).join('\n')}\n\n` : '';
    const msgs = (messages || []).map(m => m.role === 'narrator' ? `[叙述者] ${m.text}` : `[用户] ${m.text}`).join('\n');
    return `你是故事摘要助手。请将以下故事片段压缩为简洁的叙事摘要。
${existing}需要摘要的新内容：
${msgs}
要求：保留关键情节转折、角色互动、重要决策；2-4句话，100字以内；只输出摘要文本。`;
  }

  function buildVerdictPrompt(worldSetting, summaries, messages) {
    const story = (summaries || []).length > 0
      ? summaries.map(s => s.text).join('\n')
      : (messages || []).slice(-10).map(m => m.role === 'narrator' ? `[叙述者] ${m.text}` : `[用户] ${m.text}`).join('\n');
    return `以下是一段平行宇宙故事的完整记录。
## 世界观设定
场景：${worldSetting.scene || ''}
冲突：${worldSetting.conflictSeed || ''}
关键词：${(worldSetting.keywords || []).join('、')}
## 故事经过
${story}
请为这段故事写一段"判词"——总结核心：谁做了什么关键选择，走向什么结局，留下什么遗憾或圆满。
基于实际发生的故事内容，不要基于预设暗线。
风格：与世界观氛围匹配；严格不超过50字；有诗意，像印章盖在故事最后一页；只输出判词文本，不要引号。
示例：
- 民国风："法租界的雨停了三次，你们错过了两次，赶上了最后一次。"
- 赛博朋克："数据洪流里捞出一段未加密的记忆。已归档。"
- 奇幻："那条龙最终没有被杀死，它只是决定不再飞了。"`;
  }

  // ========== 主类 ==========
  class FloatingLifeApp {
    constructor(container, roche) {
      this.container = container;
      this.roche = roche;
      this.sessions = [];
      this.user = null;
      this.characters = [];
      this.worldBooks = [];
      this.page = 'list';
      this.sessionId = null;
      this.selChars = [];
      this.selWBIds = []; // 用户选取的世界书条目ID
      this.selPerspective = 'third-limited';
      this.draftTheme = ''; // 创建页题材方向草稿（防止重新渲染丢失输入）
      this.choicesCollapsed = false; // 选项栏目是否收起
      this.loading = false;
      this.styleEl = null;
    }

    async init() {
      this._injectStyles();
      await this._loadData();
      this.render();
    }

    async _loadData() {
      try { this.user = await this.roche.persona.getActiveUserPersona(); } catch(e) { console.warn(e); }
      try { this.characters = await this.roche.character.list(); } catch(e) { this.characters = []; }
      // 加载所有世界书条目（供用户选取）
      try {
        const cats = await this.roche.worldbook.list();
        this.worldBooks = [];
        if (Array.isArray(cats)) {
          for (const cat of cats) {
            try {
              // 先尝试不传 scope（获取全部）
              let entries = await this.roche.worldbook.getEntries({ categoryId: cat.id || cat.categoryId });
              if (!Array.isArray(entries) || entries.length === 0) {
                // 再尝试 global scope
                entries = await this.roche.worldbook.getEntries({ categoryId: cat.id || cat.categoryId, scope: 'global' });
              }
              if (Array.isArray(entries)) {
                this.worldBooks.push(...entries.map(e => ({ ...e, categoryId: e.categoryId || cat.id, categoryName: cat.name || cat.title || '' })));
              }
            } catch(e) {}
          }
        }
      } catch(e) { this.worldBooks = []; }
      try { this.sessions = (await this.roche.storage.get(STORAGE_KEY)) || []; } catch(e) { this.sessions = []; }
    }

    async _save() { try { await this.roche.storage.set(STORAGE_KEY, this.sessions); } catch(e) {} }

    _injectStyles() {
      this.styleEl = document.createElement('style');
      this.styleEl.textContent = `
        .roche-plugin-floating-life { position:relative; width:100%; height:100%; min-height:100%; background:linear-gradient(180deg,#141821 0%,#0d1017 100%); color:#e2e8f0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; overflow:hidden; box-sizing:border-box; display:flex; flex-direction:column; }
        .roche-plugin-floating-life * { box-sizing:border-box; }
        .roche-plugin-floating-life .fl-rain { position:absolute; inset:0; z-index:0; overflow:hidden; pointer-events:none; }
        .roche-plugin-floating-life .fl-drop { position:absolute; background:rgba(147,197,253,0.6); border-radius:9999px; animation:fl-rain linear infinite; }
        @keyframes fl-rain { 0%{transform:translateY(-20px);opacity:0} 10%{opacity:var(--op)} 90%{opacity:var(--op)} 100%{transform:translateY(100%);opacity:0} }

        /* ===== Header ===== */
        .roche-plugin-floating-life .fl-header { flex-shrink:0; padding:16px 20px 14px; background:rgba(20,24,33,0.85); backdrop-filter:blur(20px); -webkit-backdrop-filter:blur(20px); border-bottom:1px solid rgba(255,255,255,0.04); position:relative; z-index:10; }
        .roche-plugin-floating-life .fl-header-row { display:flex; align-items:center; gap:10px; }
        .roche-plugin-floating-life .fl-icon-btn { padding:6px; border-radius:9999px; background:transparent; border:none; color:rgba(148,163,184,0.6); cursor:pointer; transition:all .2s; display:flex; align-items:center; justify-content:center; flex-shrink:0; }
        .roche-plugin-floating-life .fl-icon-btn:hover { background:rgba(255,255,255,0.08); color:#cbd5e1; }
        .roche-plugin-floating-life .fl-header-center { flex:1; min-width:0; }
        .roche-plugin-floating-life .fl-title { font-size:26px; font-weight:700; color:rgba(219,234,254,0.85); letter-spacing:0.02em; line-height:1.2; }
        .roche-plugin-floating-life .fl-title-sm { font-size:18px; font-weight:600; color:rgba(219,234,254,0.75); font-family:"Songti SC","SimSun",serif; letter-spacing:0.025em; line-height:1.3; }
        .roche-plugin-floating-life .fl-subtitle { font-size:12px; color:rgba(148,163,184,0.55); margin-top:3px; letter-spacing:0.05em; }
        .roche-plugin-floating-life .fl-keywords { display:flex; gap:6px; flex-wrap:wrap; margin-top:5px; }
        .roche-plugin-floating-life .fl-keyword { padding:2px 8px; background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.06); border-radius:4px; font-size:10px; color:rgba(148,163,184,0.5); }
        .roche-plugin-floating-life .fl-archive-btn-sm { padding:5px 12px; font-size:12px; color:rgba(191,219,254,0.5); background:transparent; border:1px solid rgba(191,219,254,0.12); border-radius:8px; cursor:pointer; transition:all .2s; flex-shrink:0; font-family:"Songti SC","SimSun",serif; }
        .roche-plugin-floating-life .fl-archive-btn-sm:hover { background:rgba(191,219,254,0.06); color:rgba(191,219,254,0.7); }

        /* ===== Body ===== */
        .roche-plugin-floating-life .fl-body { flex:1; overflow-y:auto; padding:20px 20px 24px; -webkit-overflow-scrolling:touch; }
        .roche-plugin-floating-life .fl-body::-webkit-scrollbar { width:0; }

        /* ===== 分类分组（原件风格） ===== */
        .roche-plugin-floating-life .fl-group { margin-bottom:28px; }
        .roche-plugin-floating-life .fl-group-header { display:flex; align-items:center; gap:8px; margin-bottom:14px; padding:0 4px; }
        .roche-plugin-floating-life .fl-group-icon { width:18px; height:18px; color:rgba(148,163,184,0.5); flex-shrink:0; }
        .roche-plugin-floating-life .fl-group-title { font-size:15px; font-weight:600; color:rgba(203,213,225,0.7); letter-spacing:0.05em; }

        /* ===== 会话卡片（原件风格） ===== */
        .roche-plugin-floating-life .fl-session-card { width:100%; padding:18px 20px; background:rgba(255,255,255,0.025); border:1px solid rgba(255,255,255,0.06); border-radius:14px; text-align:left; cursor:pointer; transition:all .25s; margin-bottom:12px; position:relative; }
        .roche-plugin-floating-life .fl-session-card:hover { background:rgba(255,255,255,0.05); border-color:rgba(255,255,255,0.1); transform:translateY(-1px); }
        .roche-plugin-floating-life .fl-card-top { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; }
        .roche-plugin-floating-life .fl-card-title { font-size:17px; font-weight:600; color:#e2e8f0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; min-width:0; }
        .roche-plugin-floating-life .fl-card-date { font-size:12px; color:rgba(100,116,139,0.7); flex-shrink:0; padding-top:2px; }
        .roche-plugin-floating-life .fl-card-chars { font-size:13px; color:rgba(148,163,184,0.6); margin-top:6px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .roche-plugin-floating-life .fl-card-meta { display:flex; align-items:center; justify-content:space-between; margin-top:8px; }
        .roche-plugin-floating-life .fl-card-status { font-size:12px; color:rgba(100,116,139,0.7); }
        .roche-plugin-floating-life .fl-card-delete { padding:4px 6px; background:transparent; border:none; color:rgba(100,116,139,0.5); cursor:pointer; border-radius:6px; transition:all .2s; display:flex; align-items:center; }
        .roche-plugin-floating-life .fl-card-delete:hover { color:rgba(239,68,68,0.7); background:rgba(239,68,68,0.06); }
        .roche-plugin-floating-life .fl-card-verdict { font-size:13px; color:rgba(191,219,254,0.35); margin-top:10px; font-family:"Songti SC","SimSun",serif; font-style:italic; line-height:1.6; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .roche-plugin-floating-life .fl-card-archived-tag { display:inline-block; margin-top:8px; padding:2px 8px; background:rgba(191,219,254,0.05); border:1px solid rgba(191,219,254,0.1); border-radius:4px; font-size:10px; color:rgba(191,219,254,0.4); letter-spacing:0.1em; }

        /* ===== 空状态 ===== */
        .roche-plugin-floating-life .fl-empty { display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; gap:14px; padding:60px 20px; }
        .roche-plugin-floating-life .fl-empty-icon { width:48px; height:48px; color:rgba(51,65,85,0.6); }
        .roche-plugin-floating-life .fl-empty-title { font-size:15px; color:rgba(148,163,184,0.6); font-weight:500; }
        .roche-plugin-floating-life .fl-empty-desc { font-size:13px; color:rgba(100,116,139,0.6); margin-top:2px; }

        /* ===== 按钮 ===== */
        .roche-plugin-floating-life .fl-btn { display:inline-flex; align-items:center; justify-content:center; gap:6px; padding:11px 22px; border:none; border-radius:10px; font-size:14px; cursor:pointer; transition:all .2s; font-weight:500; }
        .roche-plugin-floating-life .fl-btn-primary { background:rgba(255,255,255,0.08); color:#e2e8f0; border:1px solid rgba(255,255,255,0.1); }
        .roche-plugin-floating-life .fl-btn-primary:hover { background:rgba(255,255,255,0.14); }
        .roche-plugin-floating-life .fl-btn-primary:disabled { opacity:0.3; pointer-events:none; }
        .roche-plugin-floating-life .fl-btn-ghost { background:transparent; color:rgba(148,163,184,0.6); border:1px solid rgba(255,255,255,0.08); }
        .roche-plugin-floating-life .fl-btn-ghost:hover { background:rgba(255,255,255,0.05); color:#e2e8f0; }
        .roche-plugin-floating-life .fl-btn-block { width:100%; }

        /* ===== 创建页 ===== */
        .roche-plugin-floating-life .fl-section-label { font-size:13px; color:rgba(148,163,184,0.6); margin-bottom:14px; letter-spacing:0.05em; font-weight:500; }
        .roche-plugin-floating-life .fl-char-item { width:100%; padding:14px 16px; background:rgba(255,255,255,0.025); border:1px solid rgba(255,255,255,0.06); border-radius:12px; text-align:left; cursor:pointer; transition:all .2s; display:flex; align-items:center; gap:12px; margin-bottom:10px; }
        .roche-plugin-floating-life .fl-char-item:hover { background:rgba(255,255,255,0.05); }
        .roche-plugin-floating-life .fl-char-item.active { background:rgba(147,197,253,0.06); border-color:rgba(147,197,253,0.25); }
        .roche-plugin-floating-life .fl-char-avatar { width:36px; height:36px; border-radius:9999px; flex-shrink:0; display:flex; align-items:center; justify-content:center; font-size:14px; font-weight:600; overflow:hidden; }
        .roche-plugin-floating-life .fl-char-avatar img { width:100%; height:100%; object-fit:cover; }
        .roche-plugin-floating-life .fl-char-name { font-size:14px; color:#cbd5e1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; }
        .roche-plugin-floating-life .fl-char-check { width:20px; height:20px; border-radius:9999px; border:1.5px solid rgba(255,255,255,0.15); flex-shrink:0; display:flex; align-items:center; justify-content:center; transition:all .2s; }
        .roche-plugin-floating-life .fl-char-item.active .fl-char-check { background:rgba(147,197,253,0.8); border-color:rgba(147,197,253,0.8); }
        .roche-plugin-floating-life .fl-char-check svg { opacity:0; transition:opacity .2s; }
        .roche-plugin-floating-life .fl-char-item.active .fl-char-check svg { opacity:1; }

        .roche-plugin-floating-life .fl-persp-item { width:100%; padding:14px 16px; background:rgba(255,255,255,0.025); border:1px solid rgba(255,255,255,0.06); border-radius:12px; text-align:left; cursor:pointer; transition:all .2s; margin-bottom:10px; }
        .roche-plugin-floating-life .fl-persp-item:hover { background:rgba(255,255,255,0.05); }
        .roche-plugin-floating-life .fl-persp-item.active { background:rgba(147,197,253,0.06); border-color:rgba(147,197,253,0.25); }
        .roche-plugin-floating-life .fl-persp-label { font-size:14px; color:#cbd5e1; font-weight:500; }
        .roche-plugin-floating-life .fl-persp-desc { font-size:12px; color:rgba(148,163,184,0.55); margin-top:4px; font-family:"Songti SC","SimSun",serif; }

        /* ===== 世界书选择 ===== */
        .roche-plugin-floating-life .fl-wb-group { margin-bottom:16px; }
        .roche-plugin-floating-life .fl-wb-cat-title { font-size:12px; color:rgba(100,116,139,0.7); margin-bottom:8px; padding:0 4px; letter-spacing:0.05em; }
        .roche-plugin-floating-life .fl-wb-item { width:100%; padding:10px 14px; background:rgba(255,255,255,0.02); border:1px solid rgba(255,255,255,0.05); border-radius:10px; text-align:left; cursor:pointer; transition:all .2s; display:flex; align-items:center; gap:10px; margin-bottom:6px; }
        .roche-plugin-floating-life .fl-wb-item:hover { background:rgba(255,255,255,0.04); }
        .roche-plugin-floating-life .fl-wb-item.active { background:rgba(147,197,253,0.05); border-color:rgba(147,197,253,0.2); }
        .roche-plugin-floating-life .fl-wb-check { width:16px; height:16px; border-radius:4px; border:1.5px solid rgba(255,255,255,0.15); flex-shrink:0; display:flex; align-items:center; justify-content:center; transition:all .2s; }
        .roche-plugin-floating-life .fl-wb-item.active .fl-wb-check { background:rgba(147,197,253,0.8); border-color:rgba(147,197,253,0.8); }
        .roche-plugin-floating-life .fl-wb-check svg { opacity:0; transition:opacity .2s; }
        .roche-plugin-floating-life .fl-wb-item.active .fl-wb-check svg { opacity:1; }
        .roche-plugin-floating-life .fl-wb-name { font-size:13px; color:rgba(203,213,225,0.8); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; }
        .roche-plugin-floating-life .fl-wb-hint { font-size:11px; color:rgba(100,116,139,0.6); margin-bottom:10px; padding:0 4px; line-height:1.5; }

        .roche-plugin-floating-life input, .roche-plugin-floating-life textarea { width:100%; padding:12px 16px; background:rgba(255,255,255,0.025); border:1px solid rgba(255,255,255,0.06); border-radius:10px; color:#cbd5e1; font-size:14px; outline:none; transition:border-color .2s; font-family:inherit; }
        .roche-plugin-floating-life input:focus { border-color:rgba(147,197,253,0.3); }
        .roche-plugin-floating-life input::placeholder { color:rgba(100,116,139,0.6); }

        .roche-plugin-floating-life .fl-footer { flex-shrink:0; padding:14px 20px 20px; border-top:1px solid rgba(255,255,255,0.04); background:rgba(20,24,33,0.6); }

        /* ===== 故事页 ===== */
        .roche-plugin-floating-life .fl-world-label { font-size:11px; color:rgba(148,163,184,0.45); letter-spacing:0.15em; margin-bottom:8px; text-align:center; }
        .roche-plugin-floating-life .fl-world-card { padding:16px 18px; background:rgba(255,255,255,0.02); border:1px solid rgba(255,255,255,0.05); border-radius:12px; margin-bottom:14px; }
        .roche-plugin-floating-life .fl-world-scene { font-size:14px; line-height:1.9; color:rgba(203,213,225,0.75); font-family:"Songti SC","SimSun",serif; text-indent:2em; text-align:justify; }
        .roche-plugin-floating-life .fl-world-char-name { font-size:14px; color:rgba(219,234,254,0.5); text-align:center; font-weight:500; }
        .roche-plugin-floating-life .fl-world-char-role { font-size:13px; color:rgba(148,163,184,0.6); margin-top:4px; text-indent:2em; line-height:1.7; }

        .roche-plugin-floating-life .fl-msg-narration { font-size:14px; line-height:2; color:rgba(203,213,225,0.8); font-family:"Songti SC","SimSun",serif; text-indent:2em; text-align:justify; margin-bottom:14px; }
        .roche-plugin-floating-life .fl-msg-dialogue { margin:14px 0; padding-left:14px; border-left:2px solid rgba(99,102,241,0.12); }
        .roche-plugin-floating-life .fl-msg-speaker { display:flex; align-items:center; gap:8px; margin-bottom:6px; }
        .roche-plugin-floating-life .fl-msg-speaker-name { font-size:11px; color:rgba(147,197,253,0.4); letter-spacing:0.1em; text-transform:uppercase; }
        .roche-plugin-floating-life .fl-msg-action { font-size:12px; color:rgba(129,140,248,0.4); font-style:italic; }
        .roche-plugin-floating-life .fl-msg-text { font-size:14px; line-height:1.9; color:rgba(226,232,240,0.85); font-family:"Songti SC","SimSun",serif; }
        .roche-plugin-floating-life .fl-msg-user { display:flex; justify-content:flex-end; margin:14px 0; }
        .roche-plugin-floating-life .fl-msg-user .bubble { max-width:80%; padding:10px 16px; background:rgba(96,165,250,0.05); border:1px solid rgba(147,197,253,0.1); border-radius:12px; font-size:13px; color:rgba(191,219,254,0.5); font-family:"Songti SC","SimSun",serif; line-height:1.6; }

        /* ===== 选项区域（可收起） ===== */
        .roche-plugin-floating-life .fl-choices-wrapper { margin-top:18px; border-top:1px solid rgba(255,255,255,0.04); padding-top:16px; }
        .roche-plugin-floating-life .fl-choices-toggle { display:flex; align-items:center; justify-content:center; gap:6px; width:100%; padding:8px; background:transparent; border:none; color:rgba(100,116,139,0.6); font-size:11px; letter-spacing:0.15em; cursor:pointer; transition:color .2s; margin-bottom:8px; }
        .roche-plugin-floating-life .fl-choices-toggle:hover { color:rgba(148,163,184,0.8); }
        .roche-plugin-floating-life .fl-choices-toggle .arrow { transition:transform .3s; display:inline-block; }
        .roche-plugin-floating-life .fl-choices-toggle.collapsed .arrow { transform:rotate(-90deg); }
        .roche-plugin-floating-life .fl-choices { display:flex; flex-direction:column; gap:10px; }
        .roche-plugin-floating-life .fl-choices.collapsed { display:none; }
        .roche-plugin-floating-life .fl-choices-label { font-size:11px; color:rgba(100,116,139,0.6); letter-spacing:0.2em; text-align:center; margin-bottom:4px; }
        .roche-plugin-floating-life .fl-choice-btn { width:100%; padding:14px 18px; background:rgba(255,255,255,0.02); border:1px solid rgba(255,255,255,0.06); border-radius:12px; text-align:left; cursor:pointer; transition:all .2s; display:flex; align-items:center; justify-content:space-between; gap:12px; }
        .roche-plugin-floating-life .fl-choice-btn:hover:not(:disabled) { background:rgba(255,255,255,0.06); border-color:rgba(147,197,253,0.2); transform:translateX(3px); }
        .roche-plugin-floating-life .fl-choice-btn:disabled { opacity:0.3; pointer-events:none; }
        .roche-plugin-floating-life .fl-choice-text { font-size:13px; color:rgba(148,163,184,0.8); font-family:"Songti SC","SimSun",serif; line-height:1.5; flex:1; }
        .roche-plugin-floating-life .fl-choice-tag { font-size:10px; color:rgba(100,116,139,0.7); flex-shrink:0; padding:3px 8px; background:rgba(255,255,255,0.03); border-radius:6px; letter-spacing:0.05em; }

        .roche-plugin-floating-life .fl-free-input { display:flex; gap:8px; margin-top:14px; }
        .roche-plugin-floating-life .fl-free-input input { flex:1; margin-bottom:0; border-style:dashed; font-size:13px; padding:10px 14px; }
        .roche-plugin-floating-life .fl-free-input .fl-btn { padding:0 18px; font-size:13px; }

        .roche-plugin-floating-life .fl-ending { text-align:center; margin:24px 0 16px; }
        .roche-plugin-floating-life .fl-ending-text { font-size:12px; color:rgba(191,219,254,0.4); letter-spacing:0.3em; font-family:"Songti SC","SimSun",serif; margin-bottom:16px; }
        .roche-plugin-floating-life .fl-archive-btn { padding:10px 24px; font-size:13px; color:rgba(191,219,254,0.55); background:transparent; border:1px solid rgba(191,219,254,0.15); border-radius:10px; cursor:pointer; transition:all .2s; font-family:"Songti SC","SimSun",serif; letter-spacing:0.15em; }
        .roche-plugin-floating-life .fl-archive-btn:hover { background:rgba(191,219,254,0.05); border-color:rgba(191,219,254,0.25); color:rgba(191,219,254,0.75); }
        .roche-plugin-floating-life .fl-ending-or { font-size:10px; color:rgba(51,65,85,0.8); letter-spacing:0.2em; margin-top:14px; }

        .roche-plugin-floating-life .fl-verdict { text-align:center; padding:28px 16px; margin:16px 0; border-top:1px solid rgba(255,255,255,0.05); border-bottom:1px solid rgba(255,255,255,0.05); }
        .roche-plugin-floating-life .fl-verdict-label { font-size:11px; color:rgba(191,219,254,0.25); letter-spacing:0.5em; margin-bottom:14px; }
        .roche-plugin-floating-life .fl-verdict-text { font-size:16px; line-height:2.1; color:rgba(219,234,254,0.65); font-family:"Songti SC","SimSun",serif; max-width:300px; margin:0 auto; }

        .roche-plugin-floating-life .fl-loading { text-align:center; padding:28px; color:rgba(148,163,184,0.5); font-size:13px; }
        .roche-plugin-floating-life .fl-spinner { display:inline-block; width:16px; height:16px; border:2px solid rgba(147,197,253,0.15); border-top-color:rgba(147,197,253,0.6); border-radius:50%; animation:fl-spin .8s linear infinite; vertical-align:middle; margin-right:8px; }
        @keyframes fl-spin { to { transform:rotate(360deg); } }

        .roche-plugin-floating-life .fl-parallel-label { font-size:11px; color:rgba(191,219,254,0.25); letter-spacing:0.4em; text-align:center; margin-bottom:6px; }
        .roche-plugin-floating-life .fl-divider { width:32px; height:1px; background:rgba(191,219,254,0.1); margin:0 auto 14px; }
        .roche-plugin-floating-life .fl-regen-row { display:flex; gap:8px; margin-top:14px; justify-content:flex-end; }
      `;
      document.head.appendChild(this.styleEl);
    }

    _createRain() {
      const rain = document.createElement('div');
      rain.className = 'fl-rain';
      for (let i = 0; i < 35; i++) {
        const drop = document.createElement('div');
        drop.className = 'fl-drop';
        drop.style.left = Math.random() * 100 + '%';
        drop.style.top = '0';
        drop.style.width = '1px';
        drop.style.height = (10 + Math.random() * 20) + 'px';
        drop.style.setProperty('--op', (0.05 + Math.random() * 0.1).toString());
        const duration = 1.5 + Math.random() * 2;
        drop.style.animationDuration = duration + 's';
        drop.style.animationDelay = (-duration * Math.random()) + 's';
        rain.appendChild(drop);
      }
      return rain;
    }

    destroy() {
      if (this.styleEl && this.styleEl.parentNode) this.styleEl.parentNode.removeChild(this.styleEl);
    }

    getSession(id) { return this.sessions.find(s => s.id === id) || null; }

    createSession(opts) {
      const s = {
        id: generateId('fl'), userId: this.user ? this.user.id : 'default',
        status: 'active', createdAt: Date.now(), archivedAt: null,
        worldSetting: { title:'', scene:'', characterRoles:{}, userRole:'', conflictSeed:'', keywords:[], hiddenArc:'' },
        participantIds: opts.participantIds || [],
        selectedWorldBookIds: opts.selectedWorldBookIds || [],
        perspective: opts.perspective || 'third-limited',
        userTheme: opts.userTheme || undefined,
        messages: [], summaries: [], verdict: null
      };
      this.sessions.unshift(s); this._save(); return s;
    }

    updateSession(id, updates) {
      const i = this.sessions.findIndex(s => s.id === id);
      if (i === -1) return null;
      this.sessions[i] = { ...this.sessions[i], ...updates }; this._save(); return this.sessions[i];
    }

    deleteSession(id) { this.sessions = this.sessions.filter(s => s.id !== id); this._save(); }

    async _callAI(prompt, expectJSON) {
      const r = await this.roche.ai.chat({ messages:[{role:'system',content:expectJSON?'You are a helpful assistant. Please output valid JSON.':'You are a helpful assistant.'},{role:'user',content:prompt}], temperature:0.7 });
      return r.text || r.content || '';
    }

    _getSelectedWBIds(session) {
      return session && Array.isArray(session.selectedWorldBookIds) ? session.selectedWorldBookIds : [];
    }

    async generateWorld(id) {
      const s = this.getSession(id); if (!s) throw new Error('会话不存在');
      const parts = this.characters.filter(c => s.participantIds.includes(c.id));
      const selectedWBIds = this._getSelectedWBIds(s);
      const prompt = buildWorldPrompt({
        user: this.user || {name:'旅人'},
        characters: parts,
        perspective: s.perspective,
        userTheme: s.userTheme,
        worldBooks: this.worldBooks,
        selectedWBIds
      });
      const raw = await this._callAI(prompt, true);
      const d = safeParseJSON(raw, '世界观生成');
      const ws = { title:d.title||'', scene:d.scene||'', characterRoles:d.characterRoles||{}, userRole:d.userRole||'', conflictSeed:d.conflictSeed||'', keywords:Array.isArray(d.keywords)?d.keywords:[], hiddenArc:d.hiddenArc||'' };
      const segs = normalizeSegments(d.openingSegments||[]);
      const text = segs.length>0 ? segmentsToText(segs) : String(d.openingText||'');
      const choices = normalizeChoices(d.choices||[]);
      this.updateSession(id, { worldSetting:ws, pendingOpening:{openingSegments:segs, openingText:text, openingChoices:choices} });
      return { worldSetting:ws, openingSegments:segs, openingText:text, openingChoices:choices };
    }

    confirmOpening(id) {
      const s = this.getSession(id); if (!s || !s.pendingOpening) return null;
      const { openingSegments, openingText, openingChoices } = s.pendingOpening;
      const msg = { id:generateId('msg'), role:'narrator', text:openingText, segments:openingSegments.length>0?openingSegments:undefined, choices:openingChoices, timestamp:Date.now() };
      return this.updateSession(id, { messages:[...s.messages, msg], pendingOpening:undefined });
    }

    async advanceStory(id, userInput, choiceId) {
      const s = this.getSession(id); if (!s) throw new Error('会话不存在');
      if (s.status !== 'active') throw new Error('该会话已封存');
      const parts = this.characters.filter(c => s.participantIds.includes(c.id));
      const selectedWBIds = this._getSelectedWBIds(s);
      const userMsg = { id:generateId('msg'), role:'user', text:userInput, choiceId:choiceId??undefined, timestamp:Date.now() };
      const msgs = [...s.messages, userMsg];
      const prompt = buildStoryPrompt({
        session: {...s, messages:msgs},
        user: this.user||{name:'旅人'},
        characters: parts,
        userInput,
        worldBooks: this.worldBooks,
        selectedWBIds,
        keepLast: SUMMARY_KEEP_LAST
      });
      const raw = await this._callAI(prompt, true);
      const d = safeParseJSON(raw, '故事推进');
      const segs = normalizeSegments(d.segments||[]);
      const text = segs.length>0 ? segmentsToText(segs) : String(d.narratorText||'');
      const choices = normalizeChoices(d.choices||[]);
      const narMsg = { id:generateId('msg'), role:'narrator', text, segments:segs.length>0?segs:undefined, choices, isEnding:!!d.isEnding, timestamp:Date.now() };
      const all = [...msgs, narMsg];
      this.updateSession(id, { messages:all });
      this._maybeSummary(id, all).catch(e=>console.warn(e));
      return { segments:segs, text, choices, isEnding:!!d.isEnding };
    }

    async regenerateLast(id) {
      const s = this.getSession(id); if (!s) throw new Error('会话不存在');
      const msgs = s.messages;
      if (msgs.length<2 || msgs[msgs.length-1].role!=='narrator' || msgs[msgs.length-2].role!=='user') throw new Error('没有可重新生成的内容');
      const last = msgs[msgs.length-2];
      this.updateSession(id, { messages:msgs.slice(0,-2) });
      try { return await this.advanceStory(id, last.text, last.choiceId); }
      catch(e) { this.updateSession(id, { messages:msgs }); throw e; }
    }

    async archiveSession(id) {
      const s = this.getSession(id); if (!s) throw new Error('会话不存在');
      const prompt = buildVerdictPrompt(s.worldSetting, s.summaries, s.messages);
      let verdict = '';
      try { verdict = stripQuotes((await this._callAI(prompt, false)).trim()); }
      catch(e) { verdict = '大梦一场，醒来皆忘。'; }
      return this.updateSession(id, { status:'archived', archivedAt:Date.now(), verdict });
    }

    async _maybeSummary(id, messages) {
      const s = this.getSession(id); if (!s) return;
      const covered = s.summaries.length>0 ? s.summaries[s.summaries.length-1].coveredUpTo : 0;
      if (messages.length - covered < SUMMARY_THRESHOLD) return;
      const end = messages.length - SUMMARY_KEEP_LAST;
      if (end <= covered) return;
      const toSum = messages.slice(covered, end);
      if (toSum.length === 0) return;
      const prompt = buildSummaryPrompt(toSum, s.summaries);
      const text = (await this._callAI(prompt, false)).trim();
      this.updateSession(id, { summaries:[...s.summaries, { text, coveredUpTo:end, generatedAt:Date.now() }] });
    }

    render() {
      this.container.innerHTML = '';
      const root = document.createElement('div');
      root.className = 'roche-plugin-floating-life';
      root.appendChild(this._createRain());
      this.container.appendChild(root);
      this.root = root;
      this.pageEl = root; // page 就是 root 本身，使用 flex 布局
      if (this.page === 'list') this._renderList();
      else if (this.page === 'create') this._renderCreate();
      else if (this.page === 'story') this._renderStory();
    }

    _renderList() {
      const activeSessions = this.sessions.filter(s => s.status === 'active');
      const archivedSessions = this.sessions.filter(s => s.status === 'archived');

      let html = `
        <div class="fl-header">
          <div class="fl-header-row">
            <button class="fl-icon-btn" id="fl-back-home" title="返回">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
            </button>
            <div class="fl-header-center">
              <div class="fl-title">浮生</div>
              <div class="fl-subtitle">一场醒来就忘的梦</div>
            </div>
            <button class="fl-icon-btn" id="fl-theme-toggle" title="主题">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>
            </button>
            <button class="fl-icon-btn" id="fl-new" title="开启浮生">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
            </button>
          </div>
        </div>
        <div class="fl-body">
      `;

      // 进行中分组
      html += `<div class="fl-group">
        <div class="fl-group-header">
          <svg class="fl-group-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
          <span class="fl-group-title">进行中</span>
        </div>`;
      if (activeSessions.length === 0) {
        html += `<div class="fl-empty" style="padding:32px 20px;">
          <svg class="fl-empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
          <div>
            <div class="fl-empty-title">尚无故事</div>
            <div class="fl-empty-desc">在另一个世界里，他们是谁，你又是谁？</div>
          </div>
          <button class="fl-btn fl-btn-primary" id="fl-start-empty">开启浮生</button>
        </div>`;
      } else {
        activeSessions.forEach(s => {
          html += this._renderSessionCard(s);
        });
      }
      html += `</div>`;

      // 故梦分组
      html += `<div class="fl-group">
        <div class="fl-group-header">
          <svg class="fl-group-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8v13H3V8"/><path d="M1 3h22v5H1z"/><path d="M10 12h4"/></svg>
          <span class="fl-group-title">故梦</span>
        </div>`;
      if (archivedSessions.length === 0) {
        html += `<div style="text-align:center;padding:20px;color:rgba(100,116,139,0.5);font-size:12px;">尚无封存的故事</div>`;
      } else {
        archivedSessions.forEach(s => {
          html += this._renderSessionCard(s);
        });
      }
      html += `</div>`;

      html += '</div>';
      this.pageEl.innerHTML = html;

      // 事件绑定
      this.pageEl.querySelectorAll('.fl-session-card').forEach(item => {
        item.onclick = (e) => {
          if (e.target.closest('.fl-card-delete')) return;
          this.sessionId = item.dataset.id;
          this.page = 'story';
          this.render();
        };
      });
      this.pageEl.querySelectorAll('.fl-card-delete').forEach(btn => {
        btn.onclick = async (e) => {
          e.stopPropagation();
          const id = btn.dataset.id;
          const ok = await this.roche.ui.confirm({ title:'确认删除', message:'确定删除这场梦吗？此操作不可撤销。' });
          if (ok) { this.deleteSession(id); this.render(); }
        };
      });
      const newBtn = this.pageEl.querySelector('#fl-new');
      if (newBtn) newBtn.onclick = () => { this.selChars = []; this.selWBIds = []; this.draftTheme = ''; this.page = 'create'; this.render(); };
      const startEmpty = this.pageEl.querySelector('#fl-start-empty');
      if (startEmpty) startEmpty.onclick = () => { this.selChars = []; this.selWBIds = []; this.draftTheme = ''; this.page = 'create'; this.render(); };
      this.pageEl.querySelector('#fl-back-home').onclick = () => this.roche.ui.closeApp();
      const themeBtn = this.pageEl.querySelector('#fl-theme-toggle');
      if (themeBtn) themeBtn.onclick = () => this.roche.ui.toast('主题切换功能开发中');
    }

    _renderSessionCard(s) {
      const title = s.worldSetting.title || (s.worldSetting.keywords||[]).join('·') || '新的浮生';
      const chars = (s.participantIds||[]).map(id => { const c=this.characters.find(x=>x.id===id); return c?(c.handle||c.name):id; }).join('、');
      const date = new Date(s.createdAt).toLocaleDateString('zh-CN',{month:'short',day:'numeric'});
      const isArchived = s.status === 'archived';
      return `<div class="fl-session-card" data-id="${s.id}">
        <div class="fl-card-top">
          <div class="fl-card-title">${esc(title)}</div>
          <div class="fl-card-date">${date}</div>
        </div>
        <div class="fl-card-chars">${esc(chars)}</div>
        ${isArchived && s.verdict ? `<div class="fl-card-verdict">「${esc(s.verdict)}」</div>` : ''}
        <div class="fl-card-meta">
          <span class="fl-card-status">${isArchived ? '<span class="fl-card-archived-tag">已封存</span>' : `${s.messages.length} 条消息`}</span>
          <button class="fl-card-delete" data-id="${s.id}" title="删除">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6"/></svg>
          </button>
        </div>
      </div>`;
    }

    _renderCreate() {
      const pronoun = (this.user && (this.user.gender==='男'||this.user.gender==='男性')) ? '他' : '她';
      const perspectives = [
        { value:'third-limited', label:'第三人称', desc:`「${pronoun}推开了那扇门…」` },
        { value:'second-person', label:'第二人称', desc:'「你推开了那扇门…」' },
        { value:'first-person', label:'第一人称', desc:'「我推开了那扇门…」' }
      ];

      // 按分类分组世界书
      const wbByCat = {};
      this.worldBooks.forEach(w => {
        const cat = w.categoryName || w.categoryId || '其他';
        if (!wbByCat[cat]) wbByCat[cat] = [];
        wbByCat[cat].push(w);
      });

      let html = `
        <div class="fl-header">
          <div class="fl-header-row">
            <button class="fl-icon-btn" id="fl-back-list">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
            </button>
            <div class="fl-header-center"><div class="fl-title-sm">开启浮生</div></div>
          </div>
        </div>
        <div class="fl-body">
          <div style="margin-bottom:28px;">
            <div class="fl-section-label">选择角色</div>
      `;
      if (this.characters.length === 0) {
        html += '<div style="text-align:center;padding:24px;color:rgba(148,163,184,0.6);font-size:13px;">暂无角色，请先在 Roche 中创建角色</div>';
      } else {
        this.characters.forEach(c => {
          const name = c.handle || c.name || '未知';
          const active = this.selChars.includes(c.id) ? 'active' : '';
          const color = c.avatarColor || '#64748b';
          const avatar = c.avatar ? `<img src="${esc(c.avatar)}" alt="">` : `<span style="color:${color}">${name[0]}</span>`;
          html += `<button class="fl-char-item ${active}" data-id="${c.id}">
            <div class="fl-char-avatar" style="background:${color}30">${avatar}</div>
            <div class="fl-char-name">${esc(name)}</div>
            <div class="fl-char-check">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#0d1017" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
            </div>
          </button>`;
        });
      }

      html += `</div><div style="margin-bottom:28px;">
        <div class="fl-section-label">叙事视角</div>`;
      perspectives.forEach(p => {
        const active = this.selPerspective === p.value ? 'active' : '';
        html += `<button class="fl-persp-item ${active}" data-value="${p.value}">
          <div class="fl-persp-label">${p.label}</div>
          <div class="fl-persp-desc">${p.desc}</div>
        </button>`;
      });

      // 世界书选择
      html += `</div><div style="margin-bottom:28px;">
        <div class="fl-section-label">世界书（自主选取）</div>
        <div class="fl-wb-hint">选取后，浮生将在构建世界观和推进剧情时参考这些条目。不选则完全基于角色人设自由生成。</div>`;
      if (this.worldBooks.length === 0) {
        html += '<div style="text-align:center;padding:16px;color:rgba(100,116,139,0.5);font-size:12px;">暂无可用的世界书条目</div>';
      } else {
        Object.entries(wbByCat).forEach(([catName, items]) => {
          html += `<div class="fl-wb-group">
            <div class="fl-wb-cat-title">${esc(catName)}</div>`;
          items.forEach(w => {
            const name = w.title || w.name || '未命名';
            const active = this.selWBIds.includes(w.id) ? 'active' : '';
            html += `<button class="fl-wb-item ${active}" data-id="${w.id}">
              <div class="fl-wb-check">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#0d1017" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
              </div>
              <span class="fl-wb-name">${esc(name)}</span>
            </button>`;
          });
          html += `</div>`;
        });
      }

      html += `</div><div style="margin-bottom:8px;">
        <div class="fl-section-label">题材方向 <span style="color:rgba(100,116,139,0.6);font-size:11px;font-weight:normal;">（可选，留空则 AI 随机生成）</span></div>
        <input type="text" id="fl-theme" placeholder="例：末日公路片、民国悬疑、赛博朋克…" value="${esc(this.draftTheme)}" />
      </div></div>
      <div class="fl-footer">
        <button class="fl-btn fl-btn-primary fl-btn-block" id="fl-start-dream" ${this.selChars.length===0?'disabled':''}>开启这场梦</button>
      </div>`;

      this.pageEl.innerHTML = html;

      this.pageEl.querySelector('#fl-back-list').onclick = () => { this.page='list'; this.render(); };

      this.pageEl.querySelectorAll('.fl-char-item').forEach(item => item.onclick = () => {
        this._saveDraftTheme();
        const id = item.dataset.id;
        if (this.selChars.includes(id)) {
          this.selChars = this.selChars.filter(x=>x!==id);
        } else {
          this.selChars.push(id);
        }
        this.render();
      });

      this.pageEl.querySelectorAll('.fl-persp-item').forEach(item => item.onclick = () => {
        this._saveDraftTheme();
        this.selPerspective = item.dataset.value;
        this.render();
      });

      this.pageEl.querySelectorAll('.fl-wb-item').forEach(item => item.onclick = () => {
        this._saveDraftTheme();
        const id = item.dataset.id;
        if (this.selWBIds.includes(id)) {
          this.selWBIds = this.selWBIds.filter(x=>x!==id);
        } else {
          this.selWBIds.push(id);
        }
        this.render();
      });

      this.pageEl.querySelector('#fl-start-dream').onclick = () => this._startDream();
    }

    _saveDraftTheme() {
      const input = this.pageEl && this.pageEl.querySelector('#fl-theme');
      if (input) this.draftTheme = input.value;
    }

    async _startDream() {
      if (this.selChars.length === 0) return;
      this._saveDraftTheme();
      const theme = this.draftTheme.trim();
      const s = this.createSession({
        participantIds: this.selChars,
        selectedWorldBookIds: [...this.selWBIds],
        perspective: this.selPerspective,
        userTheme: theme || undefined
      });
      this.sessionId = s.id;
      this.choicesCollapsed = false;
      this.draftTheme = ''; // 重置草稿
      this.page = 'story';
      this.render();
      await this._genWorldFlow();
    }

    _renderStory() {
      const s = this.getSession(this.sessionId);
      if (!s) { this.page='list'; this.render(); return; }
      const title = s.worldSetting.title || (s.worldSetting.keywords||[]).join('·') || '新的浮生';

      let html = `
        <div class="fl-header">
          <div class="fl-header-row">
            <button class="fl-icon-btn" id="fl-story-back">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
            </button>
            <div class="fl-header-center">
              <div class="fl-title-sm">${esc(title)}</div>
              ${(s.worldSetting.keywords||[]).length>0 ? `<div class="fl-keywords">${s.worldSetting.keywords.map(k=>`<span class="fl-keyword">${esc(k)}</span>`).join('')}</div>` : ''}
            </div>
            <button class="fl-icon-btn" id="fl-delete" title="删除">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6"/></svg>
            </button>
            ${s.status==='active' ? `<button class="fl-archive-btn-sm" id="fl-archive-header">封存</button>` : ''}
          </div>
        </div>
        <div class="fl-body" style="padding:20px 24px 24px;">
      `;

      if (s.status === 'archived' && s.verdict) {
        html += `<div class="fl-verdict">
          <div class="fl-verdict-label">判 词</div>
          <div class="fl-verdict-text">${esc(s.verdict)}</div>
        </div>`;
      }

      if (s.worldSetting.scene) {
        html += `<div class="fl-parallel-label">平 行 世 界</div><div class="fl-divider"></div>
          <div class="fl-world-card">
            <div class="fl-world-label">时 代 与 场 景</div>
            <div class="fl-world-scene">${esc(s.worldSetting.scene)}</div>
          </div>`;
        const charRoles = Object.entries(s.worldSetting.characterRoles||{});
        if (charRoles.length > 0 || s.worldSetting.userRole) {
          html += `<div class="fl-world-card">
            <div class="fl-world-label">角 色 身 份</div>`;
          charRoles.forEach(([id, role]) => {
            const c = this.characters.find(x=>x.id===id);
            const name = c ? (c.handle||c.name) : id;
            html += `<div class="fl-world-char-name">${esc(name)}</div><div class="fl-world-char-role">${esc(role)}</div>`;
          });
          if (s.worldSetting.userRole) {
            const uname = this.user ? (this.user.handle||this.user.name) : '你';
            html += `<div style="padding-top:8px;border-top:1px solid rgba(255,255,255,0.04);margin-top:8px;">
              <div class="fl-world-char-name">${esc(uname)}（你）</div>
              <div class="fl-world-char-role">${esc(s.worldSetting.userRole)}</div></div>`;
          }
          html += `</div>`;
        }
        if (s.worldSetting.conflictSeed) {
          html += `<div class="fl-world-card">
            <div class="fl-world-label">冲 突 种 子</div>
            <div class="fl-world-scene" style="text-indent:0;">${esc(s.worldSetting.conflictSeed)}</div>
          </div>`;
        }
      }

      s.messages.forEach(msg => {
        if (msg.role === 'user') {
          html += `<div class="fl-msg-user"><div class="bubble">▸ ${esc(msg.text)}</div></div>`;
        } else {
          if (msg.segments && msg.segments.length > 0) {
            html += '<div style="margin-bottom:14px;">';
            msg.segments.forEach(seg => {
              if (seg.type === 'narration') html += `<div class="fl-msg-narration">${esc(seg.text)}</div>`;
              else html += `<div class="fl-msg-dialogue">
                <div class="fl-msg-speaker">
                  <span class="fl-msg-speaker-name">${esc(seg.character||'')}</span>
                  ${seg.action ? `<span class="fl-msg-action">${esc(seg.action)}</span>` : ''}
                </div>
                <div class="fl-msg-text">「${esc(seg.text)}」</div>
              </div>`;
            });
            html += '</div>';
          } else if (msg.text) {
            html += `<div class="fl-msg-narration">${esc(msg.text)}</div>`;
          }
        }
      });

      if (s.pendingOpening && s.messages.length === 0) {
        const po = s.pendingOpening;
        html += '<div style="margin-bottom:14px;">';
        po.openingSegments.forEach(seg => {
          if (seg.type === 'narration') html += `<div class="fl-msg-narration">${esc(seg.text)}</div>`;
          else html += `<div class="fl-msg-dialogue">
            <div class="fl-msg-speaker"><span class="fl-msg-speaker-name">${esc(seg.character||'')}</span></div>
            <div class="fl-msg-text">「${esc(seg.text)}」</div>
          </div>`;
        });
        html += '</div>';
      }

      html += '</div>';
      this.pageEl.innerHTML = html;

      // 底部操作区
      const actions = document.createElement('div');
      actions.style.cssText = 'flex-shrink:0;padding:0 24px 20px;position:relative;z-index:1;';
      this.pageEl.appendChild(actions);

      if (s.status === 'archived') {
        // 已封存，无操作
      } else if (s.pendingOpening && s.messages.length === 0 && !this.loading) {
        actions.innerHTML = `<div style="display:flex;gap:10px;">
          <button class="fl-btn fl-btn-ghost" id="fl-regen-world">重新生成</button>
          <button class="fl-btn fl-btn-primary" style="flex:1;" id="fl-enter-dream">进入浮生</button>
        </div>`;
        actions.querySelector('#fl-enter-dream').onclick = () => { this.confirmOpening(this.sessionId); this.render(); };
        actions.querySelector('#fl-regen-world').onclick = () => this._genWorldFlow();
      } else if (s.messages.length === 0) {
        if (this.loading) {
          actions.innerHTML = '<div class="fl-loading"><span class="fl-spinner"></span>正在造梦…</div>';
        } else {
          actions.innerHTML = '<div style="text-align:center;"><div style="color:rgba(239,68,68,0.7);font-size:13px;margin-bottom:12px;">世界观生成失败，请重试</div><button class="fl-btn fl-btn-primary" id="fl-retry-world">重新生成世界观</button></div>';
          actions.querySelector('#fl-retry-world').onclick = () => this._genWorldFlow();
        }
      } else {
        const last = s.messages[s.messages.length - 1];
        if (last && last.role === 'narrator' && last.choices && last.choices.length > 0 && !this.loading) {
          if (last.isEnding) {
            actions.innerHTML = `<div class="fl-ending">
              <div class="fl-ending-text">故 事 似 乎 走 到 了 尾 声</div>
              <button class="fl-archive-btn" id="fl-archive">封存这段浮生</button>
              <div class="fl-ending-or">或 者 ， 继 续 书 写</div>
            </div>`;
            actions.querySelector('#fl-archive').onclick = () => this._archiveFlow();
            // 结局时仍可自由输入
            const free = this._createFreeInput();
            actions.appendChild(free);
          } else {
            // 可收起的选项区域
            const collapsed = this.choicesCollapsed;
            actions.innerHTML = `<div class="fl-choices-wrapper">
              <button class="fl-choices-toggle ${collapsed?'collapsed':''}" id="fl-toggle-choices">
                <span class="arrow">▼</span>
                <span>${collapsed ? '展开选择' : '你的选择'}</span>
              </button>
              <div class="fl-choices ${collapsed?'collapsed':''}" id="fl-choices-list"></div>
            </div>`;
            const cd = actions.querySelector('#fl-choices-list');
            last.choices.forEach(c => {
              const btn = document.createElement('button');
              btn.className = 'fl-choice-btn';
              btn.innerHTML = `<span class="fl-choice-text">${esc(c.text)}</span><span class="fl-choice-tag">${esc(c.tag||'')}</span>`;
              btn.onclick = () => this._advanceFlow(c.text, c.id);
              cd.appendChild(btn);
            });
            // 收起/展开切换
            actions.querySelector('#fl-toggle-choices').onclick = () => {
              this.choicesCollapsed = !this.choicesCollapsed;
              this.render();
            };
          }
          // 自由输入（始终可用）
          const free = this._createFreeInput();
          actions.appendChild(free);
          // 重新生成
          const regen = document.createElement('div');
          regen.className = 'fl-regen-row';
          regen.innerHTML = '<button class="fl-btn fl-btn-ghost" style="font-size:12px;padding:6px 14px;" id="fl-regen">重新生成</button>';
          actions.appendChild(regen);
          regen.querySelector('#fl-regen').onclick = () => this._regenFlow();
        } else if (this.loading) {
          actions.innerHTML = '<div class="fl-loading"><span class="fl-spinner"></span>落笔中…</div>';
        }
      }

      // Header 事件
      this.pageEl.querySelector('#fl-story-back').onclick = () => { this.sessionId=null; this.choicesCollapsed=false; this.page='list'; this.render(); };
      this.pageEl.querySelector('#fl-delete').onclick = async () => {
        const ok = await this.roche.ui.confirm({ title:'确认删除', message:'确定删除这场梦吗？此操作不可撤销。' });
        if (ok) { this.deleteSession(this.sessionId); this.sessionId=null; this.choicesCollapsed=false; this.page='list'; this.render(); }
      };
      const archiveHeader = this.pageEl.querySelector('#fl-archive-header');
      if (archiveHeader) archiveHeader.onclick = () => this._archiveFlow();

      // 滚动到底部
      setTimeout(() => { const body = this.pageEl.querySelector('.fl-body'); if (body) body.scrollTop = body.scrollHeight; }, 50);
    }

    _createFreeInput() {
      const free = document.createElement('div');
      free.className = 'fl-free-input';
      free.innerHTML = `<input type="text" id="fl-free" placeholder="或者，写下你想做的事…" />
        <button class="fl-btn fl-btn-primary" id="fl-free-send">发送</button>`;
      const input = free.querySelector('#fl-free');
      free.querySelector('#fl-free-send').onclick = () => { const t=input.value.trim(); if(t) this._advanceFlow(t); };
      input.onkeydown = e => { if(e.key==='Enter') free.querySelector('#fl-free-send').click(); };
      return free;
    }

    async _genWorldFlow() {
      if (this.loading) return;
      this.loading = true; this.render();
      try { await this.generateWorld(this.sessionId); }
      catch(e) { this.roche.ui.toast('世界观生成失败：'+e.message); }
      finally { this.loading = false; this.render(); }
    }

    async _advanceFlow(text, choiceId) {
      if (this.loading) return;
      // 点击选项后立即收起选项并显示 loading
      this.choicesCollapsed = true;
      this.loading = true; this.render();
      try { await this.advanceStory(this.sessionId, text, choiceId); }
      catch(e) { this.roche.ui.toast('故事推进失败：'+e.message); }
      finally {
        this.loading = false;
        this.choicesCollapsed = false; // 新一轮选项默认展开
        this.render();
      }
    }

    async _regenFlow() {
      if (this.loading) return;
      this.loading = true; this.render();
      try { await this.regenerateLast(this.sessionId); }
      catch(e) { this.roche.ui.toast('重新生成失败：'+e.message); }
      finally { this.loading = false; this.render(); }
    }

    async _archiveFlow() {
      if (this.loading) return;
      this.loading = true; this.render();
      try { await this.archiveSession(this.sessionId); this.roche.ui.toast('浮生已封存'); }
      catch(e) { this.roche.ui.toast('封存失败：'+e.message); }
      finally { this.loading = false; this.render(); }
    }
  }

  window.RochePlugin.register({
    id: 'floating-life',
    name: '浮生',
    version: '2.0.0',
    apps: [{
      id: 'floating-life-home',
      name: '浮生',
      icon: 'extension',
      iconImage: '',
      async mount(container, roche) {
        const app = new FloatingLifeApp(container, roche);
        container._floatingLifeApp = app;
        await app.init();
      },
      async unmount(container, roche) {
        if (container._floatingLifeApp) { container._floatingLifeApp.destroy(); container._floatingLifeApp = null; }
        container.replaceChildren();
      }
    }]
  });
})();
