/**
 * 浮生 (FloatingLife) - Roche 全信任 JS 插件 v4.2
 * 一场醒来就忘的梦
 *
 * v4.2 更新：
 * - 生成页世界书选择项可折叠/展开
 * - 人称默认改为第二人称
 * - 第二人称提示词优化（双方互称你）
 * - 新增全局最高优先级预设（首页按钮，全局生效世界书）
 * - 新增[核心守则]模块，注入系统提示词最开头
 * - 故事页文本长按可编辑保存
 * - 生成页全局预设已选项标灰不可重复选
 */
(function () {
  'use strict';
  const STORAGE_KEY = 'floating_life_sessions';
  const GLOBAL_PRESET_KEY = 'floating_life_global_preset';
  const SUMMARY_THRESHOLD = 16;
  const SUMMARY_KEEP_LAST = 8;

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
      catch (e2) {
        const err = new Error(`浮生：${context}返回的内容无法解析为 JSON`);
        err.rawText = text;
        throw err;
      }
    }
  }
  function getPerspectiveText(perspective, userName, userGender) {
    const pronoun = (userGender === '男' || userGender === '男性') ? '他' : '她';
    switch (perspective) {
      case 'second-person': return '使用第二人称叙事，自称「我」，称呼用户角色为「你」。';
      case 'first-person': return '使用第一人称叙事，自称「我」。用户角色不参与故事，只在章节末尾给出剧情引导，推动故事走向。';
      default: return `使用第三人称有限视角叙事，称呼用户角色为「${userName}」或「${pronoun}」。`;
    }
  }
  function formatWorldBooks(worldBooks, selectedIds) {
    const selected = (worldBooks || []).filter(w => selectedIds.includes(w.id));
    if (selected.length === 0) return '';
    return selected.map(w =>
      `[${w.title || w.name || '未命名'}]（类型：${w.categoryId || w.category || '未知'}）\n${w.content || w.text || ''}`
    ).join('\n');
  }
  function formatCharactersInfo(characters, worldBooks, selectedWBIds) {
    return (characters || []).map(char => {
      const lines = [`名字：${char.name || char.handle || '未知'}`];
      if (char.gender) lines.push(`性别：${char.gender}`);
      if (char.bio) lines.push(`简介：${char.bio}`);
      const personaText = char.persona || char.background || char.description || '';
      if (personaText) lines.push(`人设：${personaText}`);
      return lines.join('\n');
    }).join('\n---\n');
  }
  function buildCoreRules(worldBooks, globalPresetIds) {
    const text = formatWorldBooks(worldBooks, globalPresetIds);
    if (!text) return '';
    return `【核心守则】（必须严格遵守）\n${text}\n`;
  }
  function buildSettingContext(worldSetting, characters, user, worldBooks, selectedWBIds) {
    const parts = [];
    const wbText = formatWorldBooks(worldBooks, selectedWBIds);
    if (wbText) parts.push(`【用户选取的世界书】\n${wbText}`);
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
    return parts.join('\n');
  }
  function buildHistoryContext(messages, summaries, keepLast) {
    const parts = [];
    if (summaries && summaries.length > 0) parts.push(`【之前的故事摘要】\n${summaries.map(s => s.text).join('\n')}`);
    const recent = (messages || []).slice(-keepLast);
    if (recent.length > 0) parts.push(`【最近对话】\n${recent.map(m => m.role === 'narrator' ? `[叙述者] ${m.text}` : `[用户选择] ${m.text}`).join('\n')}`);
    return parts.join('\n');
  }
  function segmentsToText(segments) {
    return (segments || []).map(seg => {
      if (seg.type === 'narration') return seg.text;
      const action = seg.action ? `（${seg.action}）` : '';
      return `${seg.character}${action}："${seg.text}"`;
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

  function buildWorldPrompt(p) {
    const userName = p.user.name || p.user.handle || '旅人';
    const charsInfo = formatCharactersInfo(p.characters, p.worldBooks, p.selectedWBIds);
    const perspText = getPerspectiveText(p.perspective, userName, p.user.gender);
    const wbText = formatWorldBooks(p.worldBooks, p.selectedWBIds);
    const charIds = (p.characters || []).map(c => c.id).join(', ');
    const coreRules = buildCoreRules(p.worldBooks, p.globalPresetIds || []);
    const wbSection = wbText ? `## 用户选取的世界书\n以下是用户主动选取的世界书条目，在构建世界观时参考：\n${wbText}\n\n` : '';
    const themeSection = p.userTheme
      ? `## 用户指定题材方向（最高优先级）\n用户明确要求的题材是：「${p.userTheme}」\n你必须严格按照这个方向构建世界观。\n\n`
      : `## 题材方向\n由你自由发挥，请大胆创造有趣且出人意料的设定。\n\n`;
    return `${coreRules}你是「浮生」系统的世界架构师。
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
    const settingCtx = buildSettingContext(p.session.worldSetting, p.characters, p.user, p.worldBooks, p.selectedWBIds);
    const historyCtx = buildHistoryContext(p.session.messages, p.session.summaries, p.keepLast);
    const perspText = getPerspectiveText(p.session.perspective, userName, p.user.gender);
    const actionCount = (p.session.messages || []).filter(m => m.role === 'user').length;
    const coreRules = buildCoreRules(p.worldBooks, p.globalPresetIds || []);
    return `${coreRules}你是「浮生」故事的叙述者，负责推进平行宇宙剧情。
你同时扮演所有参与角色，在叙事中穿插对话和动作。
## 世界观与角色
${settingCtx}
## 叙事视角
${perspText}
## 历史上下文
${historyCtx}
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
      this.selWBIds = [];
      this.selPerspective = 'second-person';
      this.draftTheme = '';
      this.loading = false;
      this.styleEl = null;
      this._scrollTop = 0;
      this._scrollBtn = null;
      this._onScroll = null;
      this._confirmDeleteId = null;
      this._showOldMessages = false;
      this._freeText = '';
      this._pickedChoiceId = null;
      this._pickedChoiceText = '';
      this._wbCollapsed = {};
      this.globalPresetWBIds = [];
      this._editingMsgId = null;
      this._longPressTimer = null;
      this._presetWBCollapsed = {};
    }
    async init() {
      this._injectStyles();
      await this._loadData();
      this.render();
    }
    async _loadData() {
      try { this.user = await this.roche.persona.getActiveUserPersona(); } catch(e) { console.warn(e); }
      try { this.characters = await this.roche.character.list(); } catch(e) { this.characters = []; }
      try {
        const cats = await this.roche.worldbook.list();
        this.worldBooks = [];
        if (Array.isArray(cats)) {
          for (const cat of cats) {
            try {
              let entries = await this.roche.worldbook.getEntries({ categoryId: cat.id || cat.categoryId });
              if (!Array.isArray(entries) || entries.length === 0) {
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
      try { this.globalPresetWBIds = (await this.roche.storage.get(GLOBAL_PRESET_KEY)) || []; } catch(e) { this.globalPresetWBIds = []; }
    }
    async _save() { try { await this.roche.storage.set(STORAGE_KEY, this.sessions); } catch(e) {} }
    async _saveGlobalPreset() { try { await this.roche.storage.set(GLOBAL_PRESET_KEY, this.globalPresetWBIds); } catch(e) {} }
    _injectStyles() {
      this.styleEl = document.createElement('style');
      this.styleEl.textContent = `
        .roche-plugin-floating-life {
          position: fixed; top: 0; left: 0; right: 0;
          width: 100%; height: 100%; height: 100dvh;
          background: linear-gradient(180deg, #141821 0%, #0d1017 100%);
          color: #cbd5e1;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
          overflow: hidden; box-sizing: border-box;
          display: flex; flex-direction: column;
          padding-top: env(safe-area-inset-top, 0px);
          z-index: 9999;
        }
        .roche-plugin-floating-life * { box-sizing: border-box; }
        .roche-plugin-floating-life .fl-rain {
          position: absolute; inset: 0; z-index: 0;
          overflow: hidden; pointer-events: none;
        }
        .roche-plugin-floating-life .fl-drop {
          position: absolute;
          background: rgba(147, 197, 253, 0.6);
          border-radius: 9999px;
          animation: fl-rain linear infinite backwards;
        }
        @keyframes fl-rain {
          0% { transform: translateY(-20px); opacity: 0; }
          10% { opacity: var(--drop-op); }
          90% { opacity: var(--drop-op); }
          100% { transform: translateY(100vh); opacity: 0; }
        }
        .roche-plugin-floating-life .fl-header {
          flex-shrink: 0; padding: 0 16px 16px; padding-top: 16px;
          background: rgba(20, 24, 33, 0.75);
          backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
          border-bottom: 1px solid rgba(255, 255, 255, 0.04);
          position: sticky; top: 0; z-index: 10;
        }
        .roche-plugin-floating-life .fl-header-row {
          display: flex; align-items: center; gap: 8px;
        }
        .roche-plugin-floating-life .fl-icon-btn {
          padding: 6px; border-radius: 9999px;
          background: transparent; border: none;
          color: rgba(100, 116, 139, 0.8);
          cursor: pointer; transition: all .2s;
          display: flex; align-items: center; justify-content: center;
          flex-shrink: 0;
        }
        .roche-plugin-floating-life .fl-icon-btn:hover {
          background: rgba(255, 255, 255, 0.1); color: #cbd5e1;
        }
        .roche-plugin-floating-life .fl-header-center { flex: 1; min-width: 0; }
        .roche-plugin-floating-life .fl-title {
          font-size: 24px; font-weight: 700;
          color: rgba(191, 219, 254, 0.7);
          letter-spacing: 0.02em; line-height: 1.2;
        }
        .roche-plugin-floating-life .fl-title-sm {
          font-size: 18px; font-weight: 500;
          color: rgba(191, 219, 254, 0.6);
          font-family: "Songti SC", "SimSun", serif;
          letter-spacing: 0.025em; line-height: 1.3;
        }
        .roche-plugin-floating-life .fl-subtitle {
          font-size: 11px; color: rgba(100, 116, 139, 0.8);
          margin-top: 2px;
        }
        .roche-plugin-floating-life .fl-keywords {
          display: flex; gap: 6px; flex-wrap: wrap; margin-top: 2px;
        }
        .roche-plugin-floating-life .fl-keyword {
          padding: 1.5px 6px;
          background: rgba(255, 255, 255, 0.04);
          border: 1px solid rgba(255, 255, 255, 0.05);
          border-radius: 4px; font-size: 10px;
          color: rgba(100, 116, 139, 0.8);
        }
        .roche-plugin-floating-life .fl-archive-btn-sm {
          padding: 6px 12px; font-size: 12px;
          color: rgba(148, 163, 184, 0.8);
          background: transparent;
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 8px; cursor: pointer; transition: all .2s;
          flex-shrink: 0;
        }
        .roche-plugin-floating-life .fl-archive-btn-sm:hover {
          background: rgba(255, 255, 255, 0.06); color: #e2e8f0;
        }
        .roche-plugin-floating-life .fl-body {
          flex: 1; overflow-y: auto;
          padding: 16px 48px 24px;
          -webkit-overflow-scrolling: touch;
          position: relative; z-index: 1;
        }
        .roche-plugin-floating-life .fl-body::-webkit-scrollbar { width: 0; }
        .roche-plugin-floating-life .fl-body-narrow { padding: 16px 32px 20px; }
        .roche-plugin-floating-life .fl-group { margin-bottom: 24px; }
        .roche-plugin-floating-life .fl-group-header {
          display: flex; align-items: center; gap: 8px;
          margin-bottom: 12px; padding: 0 2px;
        }
        .roche-plugin-floating-life .fl-group-icon {
          width: 14px; height: 14px; flex-shrink: 0;
        }
        .roche-plugin-floating-life .fl-group-icon-active { color: rgba(147, 197, 253, 0.3); }
        .roche-plugin-floating-life .fl-group-icon-archived { color: rgba(100, 116, 139, 0.6); }
        .roche-plugin-floating-life .fl-group-title {
          font-size: 11px; color: rgba(100, 116, 139, 0.8);
          letter-spacing: 0.05em;
        }
        .roche-plugin-floating-life .fl-session-card {
          width: 100%; padding: 14px 16px;
          background: rgba(255, 255, 255, 0.03);
          border: 1px solid rgba(255, 255, 255, 0.06);
          border-radius: 8px; text-align: left; cursor: pointer;
          transition: all .2s; margin-bottom: 8px; position: relative;
        }
        .roche-plugin-floating-life .fl-session-card:hover {
          background: rgba(255, 255, 255, 0.06);
        }
        .roche-plugin-floating-life .fl-card-top {
          display: flex; align-items: flex-start;
          justify-content: space-between; gap: 8px;
        }
        .roche-plugin-floating-life .fl-card-title {
          font-size: 14px; color: #cbd5e1;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
          flex: 1; min-width: 0;
        }
        .roche-plugin-floating-life .fl-card-right {
          display: flex; align-items: center; gap: 6px; flex-shrink: 0;
        }
        .roche-plugin-floating-life .fl-card-date {
          font-size: 10px; color: rgba(71, 85, 105, 0.8); padding-top: 2px;
        }
        .roche-plugin-floating-life .fl-card-chars {
          font-size: 11px; color: rgba(100, 116, 139, 0.8);
          margin-top: 4px;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .roche-plugin-floating-life .fl-card-delete {
          padding: 4px; border-radius: 4px; background: transparent;
          border: none; cursor: pointer; transition: all .2s;
          display: flex; align-items: center;
          color: rgba(71, 85, 105, 0.8);
        }
        .roche-plugin-floating-life .fl-card-delete.confirm {
          background: rgba(239, 68, 68, 0.15); color: rgba(248, 113, 113, 1);
        }
        .roche-plugin-floating-life .fl-card-delete:hover:not(.confirm) {
          background: rgba(255, 255, 255, 0.05);
        }
        .roche-plugin-floating-life .fl-card-verdict {
          font-size: 12px; color: rgba(191, 219, 254, 0.3);
          margin-top: 8px;
          font-family: "Songti SC", "SimSun", serif;
          font-style: italic;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .roche-plugin-floating-life .fl-card-status {
          font-size: 10px; color: rgba(71, 85, 105, 0.8); margin-top: 6px;
        }
        .roche-plugin-floating-life .fl-empty {
          display: flex; flex-direction: column;
          align-items: center; justify-content: center;
          text-align: center; gap: 16px; padding-bottom: 64px;
          height: 100%;
        }
        .roche-plugin-floating-life .fl-empty-icon {
          width: 40px; height: 40px; color: rgba(51, 65, 85, 0.8);
        }
        .roche-plugin-floating-life .fl-empty-title {
          font-size: 14px; color: rgba(100, 116, 139, 0.8);
        }
        .roche-plugin-floating-life .fl-empty-desc {
          font-size: 12px; color: rgba(71, 85, 105, 0.8); margin-top: 4px;
        }
        .roche-plugin-floating-life .fl-btn {
          display: inline-flex; align-items: center; justify-content: center;
          gap: 6px; padding: 12px 20px; border: none;
          border-radius: 8px; font-size: 14px; cursor: pointer;
          transition: all .2s; font-weight: 500;
        }
        .roche-plugin-floating-life .fl-btn-primary {
          background: rgba(255, 255, 255, 0.1);
          color: #e2e8f0;
          border: 1px solid rgba(255, 255, 255, 0.1);
        }
        .roche-plugin-floating-life .fl-btn-primary:hover {
          background: rgba(255, 255, 255, 0.15);
        }
        .roche-plugin-floating-life .fl-btn-primary:disabled {
          opacity: 0.3; pointer-events: none;
        }
        .roche-plugin-floating-life .fl-btn-ghost {
          background: transparent;
          color: rgba(148, 163, 184, 0.7);
          border: 1px solid rgba(255, 255, 255, 0.08);
        }
        .roche-plugin-floating-life .fl-btn-ghost:hover {
          background: rgba(255, 255, 255, 0.05); color: #e2e8f0;
        }
        .roche-plugin-floating-life .fl-btn-block { width: 100%; }
        .roche-plugin-floating-life .fl-btn-dream {
          font-family: "Songti SC", "SimSun", serif;
          letter-spacing: 0.3em;
          color: rgba(191, 219, 254, 0.55);
          background: rgba(147, 197, 253, 0.06);
          border: 1px solid rgba(147, 197, 253, 0.15);
          text-shadow: 0 0 10px rgba(147, 197, 253, 0.25);
          transition: all .3s;
        }
        .roche-plugin-floating-life .fl-btn-dream:hover:not(:disabled) {
          background: rgba(147, 197, 253, 0.1);
          color: rgba(191, 219, 254, 0.8);
          border-color: rgba(147, 197, 253, 0.28);
          text-shadow: 0 0 16px rgba(147, 197, 253, 0.4);
        }
        .roche-plugin-floating-life .fl-btn-dream:disabled {
          opacity: 0.25; pointer-events: none;
        }
        .roche-plugin-floating-life .fl-section-label {
          font-size: 12px; color: rgba(100, 116, 139, 0.8);
          margin-bottom: 12px; letter-spacing: 0.05em;
        }
        .roche-plugin-floating-life .fl-char-item {
          width: 100%; padding: 12px 16px;
          background: rgba(255, 255, 255, 0.03);
          border: 1px solid rgba(255, 255, 255, 0.06);
          border-radius: 8px; text-align: left; cursor: pointer;
          transition: all .2s; display: flex; align-items: center;
          gap: 12px; margin-bottom: 8px;
        }
        .roche-plugin-floating-life .fl-char-item:hover {
          background: rgba(255, 255, 255, 0.06);
        }
        .roche-plugin-floating-life .fl-char-item.active {
          background: rgba(255, 255, 255, 0.1);
          border-color: rgba(255, 255, 255, 0.2);
          color: #e2e8f0;
        }
        .roche-plugin-floating-life .fl-char-avatar {
          width: 32px; height: 32px; border-radius: 9999px;
          flex-shrink: 0; display: flex; align-items: center;
          justify-content: center; font-size: 12px; font-weight: 500;
          overflow: hidden;
        }
        .roche-plugin-floating-life .fl-char-avatar img {
          width: 100%; height: 100%; object-fit: cover;
        }
        .roche-plugin-floating-life .fl-char-name {
          font-size: 14px; overflow: hidden;
          text-overflow: ellipsis; white-space: nowrap; flex: 1;
        }
        .roche-plugin-floating-life .fl-char-dot {
          width: 8px; height: 8px; border-radius: 9999px;
          background: rgba(147, 197, 253, 0.5); flex-shrink: 0;
        }
        .roche-plugin-floating-life .fl-persp-item {
          width: 100%; padding: 12px 16px;
          background: rgba(255, 255, 255, 0.03);
          border: 1px solid rgba(255, 255, 255, 0.06);
          border-radius: 8px; text-align: left; cursor: pointer;
          transition: all .2s; margin-bottom: 8px;
        }
        .roche-plugin-floating-life .fl-persp-item:hover {
          background: rgba(255, 255, 255, 0.06);
        }
        .roche-plugin-floating-life .fl-persp-item.active {
          background: rgba(255, 255, 255, 0.1);
          border-color: rgba(255, 255, 255, 0.2);
        }
        .roche-plugin-floating-life .fl-persp-label {
          font-size: 14px; color: #cbd5e1;
        }
        .roche-plugin-floating-life .fl-persp-desc {
          font-size: 11px; color: rgba(100, 116, 139, 0.8); margin-top: 2px;
        }
        .roche-plugin-floating-life .fl-wb-group { margin-bottom: 12px; }
        .roche-plugin-floating-life .fl-wb-cat-title {
          font-size: 11px; color: rgba(71, 85, 105, 0.8);
          margin-bottom: 6px; padding: 0 2px;
          cursor: pointer; display: flex; align-items: center; gap: 4px;
          user-select: none;
        }
        .roche-plugin-floating-life .fl-wb-cat-title:hover {
          color: rgba(148, 163, 184, 0.8);
        }
        .roche-plugin-floating-life .fl-wb-cat-arrow {
          transition: transform .2s; display: inline-block;
          font-size: 9px;
        }
        .roche-plugin-floating-life .fl-wb-cat-arrow.expanded {
          transform: rotate(90deg);
        }
        .roche-plugin-floating-life .fl-wb-items {
          overflow: hidden;
          max-height: 1000px;
          transition: max-height .3s ease;
        }
        .roche-plugin-floating-life .fl-wb-items.collapsed {
          max-height: 0;
        }
        .roche-plugin-floating-life .fl-wb-item {
          width: 100%; padding: 8px 12px;
          background: rgba(255, 255, 255, 0.02);
          border: 1px solid rgba(255, 255, 255, 0.05);
          border-radius: 6px; text-align: left; cursor: pointer;
          transition: all .2s; display: flex; align-items: center;
          gap: 8px; margin-bottom: 4px;
        }
        .roche-plugin-floating-life .fl-wb-item:hover {
          background: rgba(255, 255, 255, 0.04);
        }
        .roche-plugin-floating-life .fl-wb-item.active {
          background: rgba(147, 197, 253, 0.06);
          border-color: rgba(147, 197, 253, 0.2);
        }
        .roche-plugin-floating-life .fl-wb-item.global-locked {
          opacity: 0.4;
          pointer-events: none;
        }
        .roche-plugin-floating-life .fl-wb-item.global-locked .fl-wb-name::after {
          content: "（全局预设）";
          font-size: 10px;
          color: rgba(147, 197, 253, 0.5);
          margin-left: 4px;
        }
        .roche-plugin-floating-life .fl-wb-check {
          width: 14px; height: 14px; border-radius: 3px;
          border: 1.5px solid rgba(255, 255, 255, 0.15);
          flex-shrink: 0; display: flex; align-items: center;
          justify-content: center; transition: all .2s;
        }
        .roche-plugin-floating-life .fl-wb-item.active .fl-wb-check {
          background: rgba(147, 197, 253, 0.8);
          border-color: rgba(147, 197, 253, 0.8);
        }
        .roche-plugin-floating-life .fl-wb-check svg { opacity: 0; transition: opacity .2s; }
        .roche-plugin-floating-life .fl-wb-item.active .fl-wb-check svg { opacity: 1; }
        .roche-plugin-floating-life .fl-wb-name {
          font-size: 12px; color: rgba(148, 163, 184, 0.7);
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;
        }
        .roche-plugin-floating-life .fl-wb-hint {
          font-size: 11px; color: rgba(71, 85, 105, 0.8);
          margin-bottom: 8px; padding: 0 2px; line-height: 1.5;
        }
        .roche-plugin-floating-life input,
        .roche-plugin-floating-life textarea {
          width: 100%; padding: 12px 16px;
          background: rgba(255, 255, 255, 0.03);
          border: 1px solid rgba(255, 255, 255, 0.06);
          border-radius: 8px; color: #cbd5e1;
          font-size: 14px; outline: none;
          transition: border-color .2s; font-family: inherit;
        }
        .roche-plugin-floating-life input:focus {
          border-color: rgba(255, 255, 255, 0.15);
        }
        .roche-plugin-floating-life input::placeholder {
          color: rgba(71, 85, 105, 0.8);
        }
        .roche-plugin-floating-life .fl-footer {
          flex-shrink: 0; padding: 16px;
          border-top: 1px solid rgba(255, 255, 255, 0.05);
        }
        .roche-plugin-floating-life .fl-world-brief {
          padding-bottom: 16px; margin-bottom: 4px;
        }
        .roche-plugin-floating-life .fl-world-brief-scene {
          font-size: 13px; line-height: 2.0;
          color: rgba(148, 163, 184, 0.8);
          font-family: "Songti SC", "SimSun", serif;
          text-indent: 2em; text-align: justify;
        }
        .roche-plugin-floating-life .fl-world-brief-roles {
          margin-top: 12px;
        }
        .roche-plugin-floating-life .fl-world-brief-role {
          font-size: 12px; line-height: 1.9;
          color: rgba(100, 116, 139, 0.8);
          text-indent: 2em;
        }
        .roche-plugin-floating-life .fl-world-label {
          font-size: 10px; color: rgba(71, 85, 105, 0.8);
          letter-spacing: 0.1em; margin-bottom: 6px; text-align: center;
        }
        .roche-plugin-floating-life .fl-world-card {
          padding: 14px 16px;
          background: rgba(255, 255, 255, 0.03);
          border: 1px solid rgba(255, 255, 255, 0.06);
          border-radius: 8px; margin-bottom: 12px;
        }
        .roche-plugin-floating-life .fl-world-scene {
          font-size: 14px; line-height: 2.0;
          color: #cbd5e1;
          font-family: "Songti SC", "SimSun", serif;
          text-indent: 2em; text-align: justify;
        }
        .roche-plugin-floating-life .fl-world-char-name {
          font-size: 14px; color: rgba(191, 219, 254, 0.5);
          text-align: center;
        }
        .roche-plugin-floating-life .fl-world-char-role {
          font-size: 14px; line-height: 1.9; color: rgba(148, 163, 184, 0.7);
          margin-top: 2px; text-indent: 2em;
        }
        .roche-plugin-floating-life .fl-parallel-label {
          font-size: 11px; color: rgba(191, 219, 254, 0.2);
          letter-spacing: 6px; text-align: center; margin-bottom: 8px;
        }
        .roche-plugin-floating-life .fl-divider {
          width: 32px; height: 1px;
          background: rgba(191, 219, 254, 0.1);
          margin: 0 auto 16px;
        }
        .roche-plugin-floating-life .fl-msg-narration {
          font-size: 13px; line-height: 2.1;
          color: rgba(148, 163, 184, 0.8);
          font-family: "Songti SC", "SimSun", serif;
          text-indent: 2em; text-align: justify;
          margin-bottom: 14px;
          padding-left: 12px;
          border-left: 1px solid rgba(148, 163, 184, 0.12);
          position: relative;
        }
        .roche-plugin-floating-life .fl-msg-dialogue {
          margin: 20px 0; text-align: center;
          position: relative;
        }
        .roche-plugin-floating-life .fl-dialogue-avatar {
          width: 36px; height: 36px; border-radius: 9999px;
          margin: 0 auto 4px; overflow: hidden;
          display: flex; align-items: center; justify-content: center;
          font-size: 11px; font-weight: 500;
        }
        .roche-plugin-floating-life .fl-dialogue-avatar img {
          width: 100%; height: 100%; object-fit: cover;
        }
        .roche-plugin-floating-life .fl-dialogue-name {
          font-size: 11px; color: rgba(147, 197, 253, 0.35);
          letter-spacing: 0.1em; margin-top: 4px; margin-bottom: 10px;
          text-transform: uppercase;
        }
        .roche-plugin-floating-life .fl-msg-action {
          font-size: 13px; line-height: 2.0;
          color: rgba(148, 163, 184, 0.55);
          font-style: italic;
          font-family: "Songti SC", "SimSun", serif;
          margin-bottom: 10px; text-indent: 2em; text-align: justify;
        }
        .roche-plugin-floating-life .fl-msg-text {
          font-size: 14px; line-height: 2.1;
          color: rgba(226, 232, 240, 0.85);
          font-family: "Songti SC", "SimSun", serif;
          text-indent: 2em; text-align: justify;
        }
        .roche-plugin-floating-life .fl-msg-user {
          display: flex; justify-content: flex-end; margin: 4px 0 16px;
          position: relative;
        }
        .roche-plugin-floating-life .fl-msg-user .bubble {
          max-width: 80%; padding: 10px 16px;
          background: rgba(96, 165, 250, 0.04);
          border: 1px solid rgba(147, 197, 253, 0.08);
          border-radius: 8px; font-size: 13px; line-height: 1.8;
          color: rgba(191, 219, 254, 0.4);
          font-family: "Songti SC", "SimSun", serif;
        }
        .roche-plugin-floating-life .fl-edit-btn {
          position: absolute;
          top: 4px; right: 4px;
          padding: 3px 8px;
          background: rgba(147, 197, 253, 0.1);
          border: 1px solid rgba(147, 197, 253, 0.2);
          border-radius: 4px;
          font-size: 10px;
          color: rgba(147, 197, 253, 0.6);
          cursor: pointer;
          z-index: 5;
          display: none;
        }
        .roche-plugin-floating-life .fl-msg-narration:hover .fl-edit-btn,
        .roche-plugin-floating-life .fl-msg-dialogue:hover .fl-edit-btn,
        .roche-plugin-floating-life .fl-msg-user:hover .fl-edit-btn {
          display: block;
        }
        .roche-plugin-floating-life .fl-edit-textarea {
          width: 100%;
          min-height: 60px;
          padding: 8px 12px;
          background: rgba(255, 255, 255, 0.05);
          border: 1px solid rgba(147, 197, 253, 0.3);
          border-radius: 6px;
          color: #cbd5e1;
          font-size: 13px;
          font-family: inherit;
          line-height: 1.8;
          resize: vertical;
        }
        .roche-plugin-floating-life .fl-edit-actions {
          display: flex; gap: 8px; margin-top: 6px; justify-content: flex-end;
        }
        .roche-plugin-floating-life .fl-old-toggle {
          width: 100%; display: flex; align-items: center;
          gap: 8px; padding: 10px 0;
          font-size: 12px; color: rgba(100, 116, 139, 0.7);
          background: transparent; border: none; cursor: pointer;
          transition: color .2s;
        }
        .roche-plugin-floating-life .fl-old-toggle:hover {
          color: rgba(148, 163, 184, 0.8);
        }
        .roche-plugin-floating-life .fl-old-toggle .line {
          flex: 1; height: 1px; background: rgba(255, 255, 255, 0.04);
        }
        .roche-plugin-floating-life .fl-old-toggle .arrow {
          transition: transform .3s; display: inline-block;
        }
        .roche-plugin-floating-life .fl-old-toggle.expanded .arrow {
          transform: rotate(180deg);
        }
        .roche-plugin-floating-life .fl-old-messages {
          opacity: 0.7; margin-bottom: 16px;
        }
        .roche-plugin-floating-life .fl-choices-wrapper {
          margin-top: 20px;
        }
        .roche-plugin-floating-life .fl-choices-label {
          font-size: 11px; color: rgba(71, 85, 105, 0.8);
          letter-spacing: 3px; text-align: center; margin-bottom: 12px;
        }
        .roche-plugin-floating-life .fl-choices {
          display: flex; flex-direction: column; gap: 10px;
        }
        .roche-plugin-floating-life .fl-choice-btn {
          width: 100%; padding: 14px 16px;
          background: rgba(255, 255, 255, 0.02);
          border: 1px solid rgba(255, 255, 255, 0.06);
          border-radius: 8px; text-align: left; cursor: pointer;
          transition: all .2s; display: flex; align-items: center;
          justify-content: space-between; gap: 12px;
        }
        .roche-plugin-floating-life .fl-choice-btn:hover:not(:disabled) {
          background: rgba(255, 255, 255, 0.06);
          border-color: rgba(255, 255, 255, 0.15);
          transform: translateX(2px);
        }
        .roche-plugin-floating-life .fl-choice-btn:disabled {
          opacity: 0.3; pointer-events: none;
        }
        .roche-plugin-floating-life .fl-choice-text {
          font-size: 13px; color: rgba(148, 163, 184, 0.8);
          font-family: "Songti SC", "SimSun", serif; line-height: 1.7; flex: 1;
        }
        .roche-plugin-floating-life .fl-choice-tag {
          font-size: 10px; color: rgba(71, 85, 105, 0.8);
          flex-shrink: 0; margin-left: 12px; padding: 2px 6px;
          background: rgba(255, 255, 255, 0.03); border-radius: 4px;
        }
        .roche-plugin-floating-life .fl-free-input {
          display: flex; gap: 8px; margin-top: 12px;
          align-items: flex-end;
        }
        .roche-plugin-floating-life .fl-free-input textarea {
          flex: 1; margin-bottom: 0; border-style: dashed;
          font-size: 13px; padding: 12px 16px;
          resize: none; wrap: on; overflow-y: auto;
          line-height: 1.6; min-height: 42px; max-height: 120px;
          font-family: inherit;
        }
        .roche-plugin-floating-life .fl-free-send {
          padding: 0 12px; background: rgba(255, 255, 255, 0.04);
          border: 1px solid rgba(255, 255, 255, 0.06);
          border-radius: 8px; cursor: pointer; transition: all .2s;
          display: flex; align-items: center; justify-content: center;
          color: rgba(100, 116, 139, 0.8);
          height: 42px; flex-shrink: 0;
        }
        .roche-plugin-floating-life .fl-free-send:hover:not(:disabled) {
          background: rgba(255, 255, 255, 0.08);
          color: #cbd5e1;
        }
        .roche-plugin-floating-life .fl-free-send:disabled {
          opacity: 0.3; pointer-events: none;
        }
        .roche-plugin-floating-life .fl-regen-row {
          display: flex; justify-content: flex-end; margin-top: 6px;
        }
        .roche-plugin-floating-life .fl-regen-btn {
          display: inline-flex; align-items: center; gap: 6px;
          padding: 4px 10px; font-size: 11px;
          color: rgba(71, 85, 105, 0.8);
          background: transparent; border: none; cursor: pointer;
          border-radius: 4px; transition: all .2s;
        }
        .roche-plugin-floating-life .fl-regen-btn:hover {
          color: rgba(148, 163, 184, 0.8);
          background: rgba(255, 255, 255, 0.03);
        }
        .roche-plugin-floating-life .fl-ending {
          text-align: center; margin: 16px 0;
        }
        .roche-plugin-floating-life .fl-ending-text {
          font-size: 11px; color: rgba(191, 219, 254, 0.35);
          letter-spacing: 4px;
          font-family: "Songti SC", "SimSun", serif; margin-bottom: 12px;
        }
        .roche-plugin-floating-life .fl-archive-btn {
          padding: 10px 20px; font-size: 12px;
          color: rgba(191, 219, 254, 0.5);
          background: transparent;
          border: 1px solid rgba(191, 219, 254, 0.15);
          border-radius: 8px; cursor: pointer; transition: all .2s;
          font-family: "Songti SC", "SimSun", serif; letter-spacing: 0.1em;
        }
        .roche-plugin-floating-life .fl-archive-btn:hover {
          background: rgba(191, 219, 254, 0.04);
          border-color: rgba(191, 219, 254, 0.2);
        }
        .roche-plugin-floating-life .fl-ending-or {
          font-size: 10px; color: rgba(51, 65, 85, 0.8);
          letter-spacing: 2px; margin-top: 12px;
        }
        .roche-plugin-floating-life .fl-verdict {
          text-align: center; padding: 24px 16px;
          margin: 12px 0;
          border-top: 1px solid rgba(255, 255, 255, 0.06);
          border-bottom: 1px solid rgba(255, 255, 255, 0.06);
        }
        .roche-plugin-floating-life .fl-verdict-label {
          font-size: 11px; color: rgba(191, 219, 254, 0.2);
          letter-spacing: 6px; margin-bottom: 12px;
        }
        .roche-plugin-floating-life .fl-verdict-text {
          font-size: 16px; line-height: 2.2;
          color: rgba(191, 219, 254, 0.6);
          font-family: "Songti SC", "SimSun", serif;
          max-width: 280px; margin: 0 auto;
        }
        .roche-plugin-floating-life .fl-loading {
          display: flex; align-items: center; gap: 8px;
          padding: 16px 0; font-size: 11px;
          color: rgba(71, 85, 105, 0.8);
        }
        .roche-plugin-floating-life .fl-loading-center {
          position: absolute;
          top: 50%; left: 50%;
          transform: translate(-50%, -50%);
          display: flex; align-items: center; gap: 10px;
          font-size: 13px;
          color: rgba(148, 163, 184, 0.7);
          font-family: "Songti SC", "SimSun", serif;
          letter-spacing: 0.15em;
        }
        .roche-plugin-floating-life .fl-spinner {
          display: inline-block; width: 16px; height: 16px;
          border: 2px solid rgba(147, 197, 253, 0.2);
          border-top-color: rgba(147, 197, 253, 0.6);
          border-radius: 50%; animation: fl-spin .8s linear infinite;
        }
        @keyframes fl-spin { to { transform: rotate(360deg); } }
        .roche-plugin-floating-life .fl-error-box {
          padding: 12px 16px; margin: 12px 0;
          background: rgba(239, 68, 68, 0.04);
          border: 1px solid rgba(239, 68, 68, 0.12);
          border-radius: 8px; font-size: 12px;
          color: rgba(252, 165, 165, 0.7); line-height: 1.6;
        }
        .roche-plugin-floating-life .fl-error-box pre {
          margin: 8px 0 0; padding: 10px;
          background: rgba(0, 0, 0, 0.2); border-radius: 6px;
          font-size: 11px; color: rgba(203, 213, 225, 0.5);
          white-space: pre-wrap; word-break: break-all;
          max-height: 150px; overflow-y: auto;
        }
        .roche-plugin-floating-life .fl-scroll-btn {
          position: absolute; right: 16px; bottom: 80px;
          z-index: 20; padding: 10px;
          border-radius: 9999px;
          background: rgba(255, 255, 255, 0.08);
          border: 1px solid rgba(255, 255, 255, 0.1);
          backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px);
          color: rgba(148, 163, 184, 0.7);
          display: flex; align-items: center; justify-content: center;
          cursor: pointer;
          opacity: 0; transform: translateY(8px);
          transition: opacity .3s, transform .3s, background .2s;
          pointer-events: none;
          box-shadow: 0 4px 12px rgba(0,0,0,0.2);
        }
        .roche-plugin-floating-life .fl-scroll-btn.visible {
          opacity: 1; transform: translateY(0); pointer-events: auto;
        }
        .roche-plugin-floating-life .fl-scroll-btn:hover {
          background: rgba(255, 255, 255, 0.14);
          color: #e2e8f0;
        }
        .roche-plugin-floating-life .fl-bottom-anchor {
          height: 1px; width: 100%;
        }
        .roche-plugin-floating-life .fl-preset-count {
          font-size: 10px;
          color: rgba(147, 197, 253, 0.5);
          margin-left: 6px;
        }
      `;
      document.head.appendChild(this.styleEl);
    }
    _createRain() {
      const rain = document.createElement('div');
      rain.className = 'fl-rain';
      for (let i = 0; i < 40; i++) {
        const drop = document.createElement('div');
        drop.className = 'fl-drop';
        drop.style.left = Math.random() * 100 + '%';
        drop.style.top = '0';
        drop.style.width = '1px';
        drop.style.height = (12 + Math.random() * 18) + 'px';
        drop.style.setProperty('--drop-op', (0.06 + Math.random() * 0.12).toString());
        const duration = 1.2 + Math.random() * 1.8;
        drop.style.animationDuration = duration + 's';
        drop.style.animationDelay = (Math.random() * 4) + 's';
        rain.appendChild(drop);
      }
      return rain;
    }
    destroy() {
      this._removeScrollListener();
      if (this._longPressTimer) { clearTimeout(this._longPressTimer); this._longPressTimer = null; }
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
        perspective: opts.perspective || 'second-person',
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
    async _callAI(prompt) {
      let temperature = 0.7;
      try {
        if (this.roche.ai && typeof this.roche.ai.getConfig === 'function') {
          const cfg = await this.roche.ai.getConfig();
          if (cfg && cfg.temperature != null) temperature = cfg.temperature;
        }
      } catch(e) {}
      const messages = [
        { role:'system', content: 'You are a helpful assistant.' },
        { role:'user', content: prompt }
      ];
      const r = await this.roche.ai.chat({ messages, temperature });
      if (!r) return '';
      if (typeof r.text === 'function') { try { return r.text() || ''; } catch(e) {} }
      if (typeof r.text === 'string') return r.text;
      if (typeof r.content === 'function') { try { return r.content() || ''; } catch(e) {} }
      if (typeof r.content === 'string') return r.content;
      return '';
    }
    _getSelectedWBIds(session) {
      return session && Array.isArray(session.selectedWorldBookIds) ? session.selectedWorldBookIds : [];
    }
    _getCharById(id) {
      return this.characters.find(c => c.id === id) || null;
    }
    _getCharByName(name) {
      if (!name) return null;
      return this.characters.find(c => (c.handle || c.name) === name) || null;
    }
    _renderCharAvatar(char, name) {
      if (char && char.avatar) {
        return `<div class="fl-dialogue-avatar"><img src="${esc(char.avatar)}" alt=""></div>`;
      }
      const color = (char && char.avatarColor) || '#94a3b8';
      const initial = (name || '?')[0];
      return `<div class="fl-dialogue-avatar" style="background:${color}25;color:${color}">${esc(initial)}</div>`;
    }
    async generateWorld(id) {
      const s = this.getSession(id); if (!s) throw new Error('会话不存在');
      const parts = this.characters.filter(c => s.participantIds.includes(c.id));
      const selectedWBIds = this._getSelectedWBIds(s);
      const prompt = buildWorldPrompt({
        user: this.user || {name:'旅人'},
        characters: parts, perspective: s.perspective,
        userTheme: s.userTheme, worldBooks: this.worldBooks, selectedWBIds,
        globalPresetIds: this.globalPresetWBIds
      });
      const raw = await this._callAI(prompt);
      let d;
      try {
        d = safeParseJSON(raw, '世界观生成');
      } catch (e) {
        d = {
          title: '未命名之梦',
          scene: e.rawText || raw || '（世界观生成内容解析失败）',
          characterRoles: {}, userRole: '', conflictSeed: '',
          keywords: [], hiddenArc: '',
          openingSegments: [{ type:'narration', text: e.rawText || raw || '（内容解析失败，请尝试重新生成）' }],
          choices: [], _parseError: true, _rawText: raw
        };
      }
      const ws = {
        title: d.title || '', scene: d.scene || '',
        characterRoles: d.characterRoles || {}, userRole: d.userRole || '',
        conflictSeed: d.conflictSeed || '',
        keywords: Array.isArray(d.keywords) ? d.keywords : [],
        hiddenArc: d.hiddenArc || ''
      };
      const segs = normalizeSegments(d.openingSegments || []);
      const text = segs.length > 0 ? segmentsToText(segs) : String(d.openingText || '');
      const choices = normalizeChoices(d.choices || []);
      this.updateSession(id, {
        worldSetting: ws,
        pendingOpening: { openingSegments: segs, openingText: text, openingChoices: choices, parseError: !!d._parseError, rawText: d._rawText || null }
      });
      return { worldSetting: ws, openingSegments: segs, openingText: text, openingChoices: choices };
    }
    confirmOpening(id) {
      const s = this.getSession(id); if (!s || !s.pendingOpening) return null;
      const { openingSegments, openingText, openingChoices } = s.pendingOpening;
      const msg = {
        id: generateId('msg'), role: 'narrator', text: openingText,
        segments: openingSegments.length > 0 ? openingSegments : undefined,
        choices: openingChoices, timestamp: Date.now()
      };
      return this.updateSession(id, { messages: [...s.messages, msg], pendingOpening: undefined });
    }
    async advanceStory(id, userInput, choiceId, skipUserAdd = false) {
      const s = this.getSession(id); if (!s) throw new Error('会话不存在');
      if (s.status !== 'active') throw new Error('该会话已封存');
      const parts = this.characters.filter(c => s.participantIds.includes(c.id));
      const selectedWBIds = this._getSelectedWBIds(s);
      let msgs;
      if (skipUserAdd) {
        msgs = [...s.messages];
      } else {
        const userMsg = { id: generateId('msg'), role: 'user', text: userInput, choiceId: choiceId ?? undefined, timestamp: Date.now() };
        msgs = [...s.messages, userMsg];
      }
      const prompt = buildStoryPrompt({
        session: {...s, messages: msgs},
        user: this.user || {name:'旅人'},
        characters: parts, userInput,
        worldBooks: this.worldBooks, selectedWBIds,
        keepLast: SUMMARY_KEEP_LAST,
        globalPresetIds: this.globalPresetWBIds
      });
      const raw = await this._callAI(prompt);
      let d;
      try {
        d = safeParseJSON(raw, '故事推进');
      } catch (e) {
        d = {
          segments: [{ type: 'narration', text: e.rawText || raw || '（故事推进内容解析失败，请尝试重新生成）' }],
          choices: [], isEnding: false, _parseError: true
        };
      }
      const segs = normalizeSegments(d.segments || []);
      const text = segs.length > 0 ? segmentsToText(segs) : String(d.narratorText || '');
      const choices = normalizeChoices(d.choices || []);
      const narMsg = {
        id: generateId('msg'), role: 'narrator', text,
        segments: segs.length > 0 ? segs : undefined,
        choices, isEnding: !!d.isEnding, parseError: !!d._parseError,
        timestamp: Date.now()
      };
      const all = [...msgs, narMsg];
      this.updateSession(id, { messages: all });
      this._maybeSummary(id, all).catch(e=>console.warn(e));
      return { segments: segs, text, choices, isEnding: !!d.isEnding };
    }
    async regenerateLast(id) {
      const s = this.getSession(id); if (!s) throw new Error('会话不存在');
      const msgs = s.messages;
      if (msgs.length < 2 || msgs[msgs.length-1].role !== 'narrator' || msgs[msgs.length-2].role !== 'user')
        throw new Error('没有可重新生成的内容');
      const lastUser = msgs[msgs.length-2];
      this.updateSession(id, { messages: msgs.slice(0, -1) });
      try { return await this.advanceStory(id, lastUser.text, lastUser.choiceId, true); }
      catch(e) { this.updateSession(id, { messages: msgs }); throw e; }
    }
    async archiveSession(id) {
      const s = this.getSession(id); if (!s) throw new Error('会话不存在');
      const prompt = buildVerdictPrompt(s.worldSetting, s.summaries, s.messages);
      let verdict = '';
      try { verdict = stripQuotes((await this._callAI(prompt)).trim()); }
      catch(e) { verdict = '大梦一场，醒来皆忘。'; }
      return this.updateSession(id, { status: 'archived', archivedAt: Date.now(), verdict });
    }
    async _maybeSummary(id, messages) {
      const s = this.getSession(id); if (!s) return;
      const covered = s.summaries.length > 0 ? s.summaries[s.summaries.length-1].coveredUpTo : 0;
      if (messages.length - covered < SUMMARY_THRESHOLD) return;
      const end = messages.length - SUMMARY_KEEP_LAST;
      if (end <= covered) return;
      const toSum = messages.slice(covered, end);
      if (toSum.length === 0) return;
      const prompt = buildSummaryPrompt(toSum, s.summaries);
      const text = (await this._callAI(prompt)).trim();
      this.updateSession(id, { summaries: [...s.summaries, { text, coveredUpTo: end, generatedAt: Date.now() }] });
    }
    _saveScroll() {
      const body = this.pageEl && this.pageEl.querySelector('.fl-body');
      if (body) this._scrollTop = body.scrollTop;
    }
    _restoreScroll() {
      const body = this.pageEl && this.pageEl.querySelector('.fl-body');
      if (body) body.scrollTop = this._scrollTop;
    }
    _setupScrollButton() {
      this._removeScrollListener();
      const body = this.pageEl && this.pageEl.querySelector('.fl-body');
      if (!body) return;
      const btn = document.createElement('button');
      btn.className = 'fl-scroll-btn';
      btn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6" /></svg>';
      btn.onclick = () => {
        const anchor = this.pageEl.querySelector('.fl-bottom-anchor');
        if (anchor) anchor.scrollIntoView({ behavior: 'smooth' });
        else body.scrollTo({ top: body.scrollHeight, behavior: 'smooth' });
      };
      this.pageEl.appendChild(btn);
      this._scrollBtn = btn;
      this._onScroll = () => {
        const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 300;
        if (atBottom) btn.classList.remove('visible');
        else btn.classList.add('visible');
      };
      body.addEventListener('scroll', this._onScroll, { passive: true });
      this._onScroll();
    }
    _removeScrollListener() {
      if (this._onScroll && this.pageEl) {
        const body = this.pageEl.querySelector('.fl-body');
        if (body) body.removeEventListener('scroll', this._onScroll);
      }
      this._onScroll = null;
      this._scrollBtn = null;
    }
    render() {
      this._removeScrollListener();
      this.container.innerHTML = '';
      const root = document.createElement('div');
      root.className = 'roche-plugin-floating-life';
      this.container.appendChild(root);
      this.root = root;
      this.pageEl = root;
      if (this.page === 'list') this._renderList();
      else if (this.page === 'create') this._renderCreate();
      else if (this.page === 'preset') this._renderPreset();
      else if (this.page === 'story') this._renderStory();
      if (this.page === 'story') root.appendChild(this._createRain());
    }
    _renderList() {
      const activeSessions = this.sessions.filter(s => s.status === 'active');
      const archivedSessions = this.sessions.filter(s => s.status === 'archived');
      const presetCount = this.globalPresetWBIds.length;
      let html = `
        <div class="fl-header">
          <div class="fl-header-row">
            <button class="fl-icon-btn" id="fl-back-home" title="返回">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6" /></svg>
            </button>
            <div class="fl-header-center">
              <div class="fl-title">浮生</div>
              <div class="fl-subtitle">一场醒来就忘的梦</div>
            </div>
            <button class="fl-icon-btn" id="fl-preset-btn" title="最高优先级预设">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" /></svg>
              ${presetCount > 0 ? `<span class="fl-preset-count">${presetCount}</span>` : ''}
            </button>
            <button class="fl-icon-btn" id="fl-new" title="开启浮生">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14" /></svg>
            </button>
          </div>
        </div>
        <div class="fl-body fl-body-narrow">
      `;
      html += `<div class="fl-group">
        <div class="fl-group-header">
          <svg class="fl-group-icon fl-group-icon-active" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
          <span class="fl-group-title">进行中</span>
        </div>`;
      if (activeSessions.length === 0) {
        html += `<div class="fl-empty">
          <svg class="fl-empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></svg>
          <div>
            <div class="fl-empty-title">尚无故事</div>
            <div class="fl-empty-desc">在另一个世界里，他们是谁，你又是谁？</div>
          </div>
          <button class="fl-btn fl-btn-primary" id="fl-start-empty">开启浮生</button>
        </div>`;
      } else {
        activeSessions.forEach(s => { html += this._renderSessionCard(s); });
      }
      html += `</div>`;
      html += `<div class="fl-group">
        <div class="fl-group-header">
          <svg class="fl-group-icon fl-group-icon-archived" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 8v13H3V8" /><path d="M1 3h22v5H1z" /><path d="M10 12h4" /></svg>
          <span class="fl-group-title">故梦</span>
        </div>`;
      if (archivedSessions.length === 0) {
        html += `<div style="text-align:center;padding:16px;color:rgba(71,85,105,0.8);font-size:11px;">尚无封存的故事</div>`;
      } else {
        archivedSessions.forEach(s => { html += this._renderSessionCard(s); });
      }
      html += `</div>`;
      html += '</div>';
      this.pageEl.innerHTML = html;
      this.pageEl.querySelectorAll('.fl-session-card').forEach(item => {
        item.onclick = (e) => {
          if (e.target.closest('.fl-card-delete')) return;
          this._confirmDeleteId = null;
          this.sessionId = item.dataset.id;
          this._scrollTop = 0;
          this._showOldMessages = false;
          this._freeText = '';
          this._pickedChoiceId = null;
          this._pickedChoiceText = '';
          this.page = 'story';
          this.render();
        };
      });
      this.pageEl.querySelectorAll('.fl-card-delete').forEach(btn => {
        btn.onclick = (e) => {
          e.stopPropagation();
          const id = btn.dataset.id;
          if (this._confirmDeleteId === id) {
            this.deleteSession(id);
            this._confirmDeleteId = null;
            this.render();
          } else {
            this._confirmDeleteId = id;
            btn.classList.add('confirm');
            btn.title = '再点一次确认删除';
          }
        };
      });
      const newBtn = this.pageEl.querySelector('#fl-new');
      if (newBtn) newBtn.onclick = () => { this.selChars = []; this.selWBIds = []; this.draftTheme = ''; this._scrollTop = 0; this.page = 'create'; this.render(); };
      const startEmpty = this.pageEl.querySelector('#fl-start-empty');
      if (startEmpty) startEmpty.onclick = () => { this.selChars = []; this.selWBIds = []; this.draftTheme = ''; this._scrollTop = 0; this.page = 'create'; this.render(); };
      this.pageEl.querySelector('#fl-back-home').onclick = () => this.roche.ui.closeApp();
      const presetBtn = this.pageEl.querySelector('#fl-preset-btn');
      if (presetBtn) presetBtn.onclick = () => { this._scrollTop = 0; this.page = 'preset'; this.render(); };
    }
    _renderSessionCard(s) {
      const title = s.worldSetting.title || (s.worldSetting.keywords||[]).join('·') || '新的浮生';
      const chars = (s.participantIds||[]).map(id => { const c=this.characters.find(x=>x.id===id); return c?(c.handle||c.name):id; }).join('、');
      const date = new Date(s.createdAt).toLocaleDateString('zh-CN',{month:'short',day:'numeric'});
      const isArchived = s.status === 'archived';
      const confirmCls = this._confirmDeleteId === s.id ? 'confirm' : '';
      return `<div class="fl-session-card" data-id="${s.id}">
        <div class="fl-card-top">
          <div class="fl-card-title">${esc(title)}</div>
          <div class="fl-card-right">
            <span class="fl-card-date">${date}</span>
            <button class="fl-card-delete ${confirmCls}" data-id="${s.id}" title="${this._confirmDeleteId === s.id ? '再点一次确认删除' : '删除'}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6" /></svg>
            </button>
          </div>
        </div>
        <div class="fl-card-chars">${esc(chars)}</div>
        ${isArchived && s.verdict ? `<div class="fl-card-verdict">「${esc(s.verdict)}」</div>` : ''}
        <div class="fl-card-status">${isArchived ? '已封存' : `${s.messages.length} 条消息`}</div>
      </div>`;
    }
    _renderWBList(worldBooks, selectedIds, collapsedState, globalLockedIds, onCatClick, onItemClick) {
      const wbByCat = {};
      (worldBooks || []).forEach(w => {
        const cat = w.categoryName || w.categoryId || '其他';
        if (!wbByCat[cat]) wbByCat[cat] = [];
        wbByCat[cat].push(w);
      });
      let html = '';
      Object.entries(wbByCat).forEach(([catName, items]) => {
        const isCollapsed = !!collapsedState[catName];
        const selectedInCat = items.filter(w => selectedIds.includes(w.id)).length;
        html += `<div class="fl-wb-group">
          <div class="fl-wb-cat-title" data-cat="${esc(catName)}">
            <span class="fl-wb-cat-arrow ${isCollapsed ? '' : 'expanded'}">▶</span>
            <span>${esc(catName)}</span>
            ${selectedInCat > 0 ? `<span class="fl-preset-count">已选${selectedInCat}</span>` : ''}
          </div>
          <div class="fl-wb-items ${isCollapsed ? 'collapsed' : ''}">`;
        items.forEach(w => {
          const name = w.title || w.name || '未命名';
          const active = selectedIds.includes(w.id) ? 'active' : '';
          const locked = (globalLockedIds || []).includes(w.id) ? 'global-locked' : '';
          html += `<button class="fl-wb-item ${active} ${locked}" data-id="${w.id}">
            <div class="fl-wb-check">
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#0d1017" stroke-width="3"><path d="M20 6L9 17l-5-5" /></svg>
            </div>
            <span class="fl-wb-name">${esc(name)}</span>
          </button>`;
        });
        html += `</div></div>`;
      });
      return html;
    }
    _renderCreate() {
      const pronoun = (this.user && (this.user.gender==='男'||this.user.gender==='男性')) ? '他' : '她';
      const perspectives = [
        { value:'third-limited', label:'第三人称', desc:`「${pronoun}推开了那扇门…」` },
        { value:'second-person', label:'第二人称', desc:'「你推开了那扇门…」' },
        { value:'first-person', label:'第一人称', desc:'「我推开了那扇门…」' }
      ];
      let html = `
        <div class="fl-header">
          <div class="fl-header-row">
            <button class="fl-icon-btn" id="fl-back-list">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6" /></svg>
            </button>
            <div class="fl-header-center"><div class="fl-title">开启浮生</div></div>
          </div>
        </div>
        <div class="fl-body fl-body-narrow">
          <div style="margin-bottom:24px;">
            <div class="fl-section-label">选择角色</div>
      `;
      if (this.characters.length === 0) {
        html += '<div style="text-align:center;padding:24px;color:rgba(100,116,139,0.8);font-size:12px;">暂无角色，请先在 Roche 中创建角色</div>';
      } else {
        this.characters.forEach(c => {
          const name = c.handle || c.name || '未知';
          const active = this.selChars.includes(c.id) ? 'active' : '';
          const color = c.avatarColor || '#64748b';
          const avatar = c.avatar ? `<img src="${esc(c.avatar)}" alt="">` : `<span style="color:${color}">${name[0]}</span>`;
          html += `<button class="fl-char-item ${active}" data-id="${c.id}">
            <div class="fl-char-avatar" style="background:${color}40">${avatar}</div>
            <div class="fl-char-name">${esc(name)}</div>
            ${this.selChars.includes(c.id) ? '<div class="fl-char-dot"></div>' : ''}
          </button>`;
        });
      }
      html += `</div><div style="margin-bottom:24px;">
        <div class="fl-section-label">叙事视角</div>`;
      perspectives.forEach(p => {
        const active = this.selPerspective === p.value ? 'active' : '';
        html += `<button class="fl-persp-item ${active}" data-value="${p.value}">
          <div class="fl-persp-label">${p.label}</div>
          <div class="fl-persp-desc">${p.desc}</div>
        </button>`;
      });
      html += `</div><div style="margin-bottom:24px;">
        <div class="fl-section-label">世界书（自主选取）</div>
        <div class="fl-wb-hint">选取后，浮生将在构建世界观和推进剧情时参考这些条目。已设为全局预设的条目会自动生效并标灰，无需重复选择。</div>`;
      if (this.worldBooks.length === 0) {
        html += '<div style="text-align:center;padding:14px;color:rgba(71,85,105,0.8);font-size:11px;">暂无可用的世界书条目</div>';
      } else {
        html += this._renderWBList(this.worldBooks, this.selWBIds, this._wbCollapsed, this.globalPresetWBIds);
      }
      html += `</div><div style="margin-bottom:8px;">
        <div class="fl-section-label">题材方向 <span style="color:rgba(71,85,105,0.8);font-size:11px;">（可选，留空则 AI 随机生成）</span></div>
        <input type="text" id="fl-theme" placeholder="例：末日公路片、民国悬疑、赛博朋克…" value="${esc(this.draftTheme)}" />
      </div></div>
      <div class="fl-footer">
        <button class="fl-btn fl-btn-block fl-btn-dream" id="fl-start-dream" ${this.selChars.length===0?'disabled':''}>入梦</button>
      </div>`;
      this.pageEl.innerHTML = html;
      requestAnimationFrame(() => this._restoreScroll());
      this.pageEl.querySelector('#fl-back-list').onclick = () => { this.page='list'; this._scrollTop=0; this.render(); };
      this.pageEl.querySelectorAll('.fl-char-item').forEach(item => item.onclick = () => {
        this._saveScroll();
        this._saveDraftTheme();
        const id = item.dataset.id;
        if (this.selChars.includes(id)) this.selChars = this.selChars.filter(x=>x!==id);
        else this.selChars.push(id);
        this.render();
      });
      this.pageEl.querySelectorAll('.fl-persp-item').forEach(item => item.onclick = () => {
        this._saveScroll();
        this._saveDraftTheme();
        this.selPerspective = item.dataset.value;
        this.render();
      });
      this.pageEl.querySelectorAll('.fl-wb-cat-title').forEach(el => el.onclick = () => {
        this._saveScroll();
        this._saveDraftTheme();
        const cat = el.dataset.cat;
        this._wbCollapsed[cat] = !this._wbCollapsed[cat];
        this.render();
      });
      this.pageEl.querySelectorAll('.fl-wb-item').forEach(item => item.onclick = () => {
        if (item.classList.contains('global-locked')) return;
        this._saveScroll();
        this._saveDraftTheme();
        const id = item.dataset.id;
        if (this.selWBIds.includes(id)) this.selWBIds = this.selWBIds.filter(x=>x!==id);
        else this.selWBIds.push(id);
        this.render();
      });
      this.pageEl.querySelector('#fl-start-dream').onclick = () => this._startDream();
    }
    _renderPreset() {
      let html = `
        <div class="fl-header">
          <div class="fl-header-row">
            <button class="fl-icon-btn" id="fl-preset-back">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6" /></svg>
            </button>
            <div class="fl-header-center">
              <div class="fl-title-sm">最高优先级预设</div>
              <div class="fl-subtitle">选中的世界书将作为核心守则全局生效</div>
            </div>
          </div>
        </div>
        <div class="fl-body fl-body-narrow">
          <div style="margin-bottom:16px;">
            <div class="fl-wb-hint" style="color:rgba(148,163,184,0.7);">这些世界书条目将以【核心守则】的形式注入每一次 AI 调用的最开头，优先级高于所有其他设定。适用于固定的世界观规则、角色设定、风格要求等。</div>
          </div>
          <div class="fl-section-label">选择全局预设世界书（已选 ${this.globalPresetWBIds.length} 项）</div>`;
      if (this.worldBooks.length === 0) {
        html += '<div style="text-align:center;padding:24px;color:rgba(100,116,139,0.8);font-size:12px;">暂无世界书，请先在 Roche 中创建世界书条目</div>';
      } else {
        html += this._renderWBList(this.worldBooks, this.globalPresetWBIds, this._presetWBCollapsed, []);
      }
      html += `</div>
      <div class="fl-footer">
        <button class="fl-btn fl-btn-block fl-btn-primary" id="fl-preset-save">保存预设</button>
      </div>`;
      this.pageEl.innerHTML = html;
      this.pageEl.querySelector('#fl-preset-back').onclick = () => { this.page='list'; this._scrollTop=0; this.render(); };
      this.pageEl.querySelectorAll('.fl-wb-cat-title').forEach(el => el.onclick = () => {
        const cat = el.dataset.cat;
        this._presetWBCollapsed[cat] = !this._presetWBCollapsed[cat];
        this.render();
      });
      this.pageEl.querySelectorAll('.fl-wb-item').forEach(item => item.onclick = () => {
        const id = item.dataset.id;
        if (this.globalPresetWBIds.includes(id)) this.globalPresetWBIds = this.globalPresetWBIds.filter(x=>x!==id);
        else this.globalPresetWBIds.push(id);
        this.render();
      });
      this.pageEl.querySelector('#fl-preset-save').onclick = async () => {
        await this._saveGlobalPreset();
        this.roche.ui.toast(`已保存 ${this.globalPresetWBIds.length} 项全局预设`);
        this.page='list';
        this.render();
      };
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
      this.draftTheme = '';
      this._scrollTop = 0;
      this._showOldMessages = false;
      this._freeText = '';
      this._pickedChoiceId = null;
      this._pickedChoiceText = '';
      this.page = 'story';
      this.render();
      await this._genWorldFlow();
    }
    _renderStory() {
      const s = this.getSession(this.sessionId);
      if (!s) { this.page='list'; this.render(); return; }
      const title = s.worldSetting.title || (s.worldSetting.keywords||[]).join('·') || '新的浮生';
      const isArchived = s.status === 'archived';
      const chars = this.characters.filter(c => s.participantIds.includes(c.id));
      let html = `
        <div class="fl-header">
          <div class="fl-header-row">
            <button class="fl-icon-btn" id="fl-story-back">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6" /></svg>
            </button>
            <div class="fl-header-center">
              <div class="fl-title-sm">${esc(title)}</div>
              ${(s.worldSetting.keywords||[]).length>0 ? `<div class="fl-keywords">${s.worldSetting.keywords.map(k=>`<span class="fl-keyword">${esc(k)}</span>`).join('')}</div>` : ''}
            </div>
            <button class="fl-icon-btn" id="fl-delete" title="删除">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6" /></svg>
            </button>
            ${!isArchived ? `<button class="fl-archive-btn-sm" id="fl-archive-header">封存</button>` : ''}
          </div>
        </div>
        <div class="fl-body">
      `;
      if (isArchived && s.verdict) {
        html += `<div class="fl-verdict">
          <div class="fl-verdict-label">判 词</div>
          <div class="fl-verdict-text">${esc(s.verdict)}</div>
        </div>`;
      }
      if (s.messages.length === 0 && s.worldSetting.scene && !this.loading) {
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
            const c = this._getCharById(id);
            const name = c ? (c.handle||c.name) : id;
            html += `<div class="fl-world-char-name">${esc(name)}</div><div class="fl-world-char-role">${esc(role)}</div>`;
          });
          if (s.worldSetting.userRole) {
            const uname = this.user ? (this.user.handle||this.user.name) : '你';
            html += `<div style="padding-top:6px;border-top:1px solid rgba(255,255,255,0.04);margin-top:6px;">
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
      if (s.messages.length > 0 && s.worldSetting.scene) {
        html += `<div class="fl-world-brief">
          <div class="fl-world-brief-scene">${esc(s.worldSetting.scene)}</div>
          <div class="fl-world-brief-roles">`;
        chars.forEach(c => {
          const role = s.worldSetting.characterRoles[c.id];
          if (role) html += `<div class="fl-world-brief-role">${esc(c.handle||c.name)}——${esc(role)}</div>`;
        });
        if (s.worldSetting.userRole) {
          const uname = this.user ? (this.user.handle||this.user.name) : '你';
          html += `<div class="fl-world-brief-role">${esc(uname)}——${esc(s.worldSetting.userRole)}</div>`;
        }
        html += `</div></div>`;
      }
      const lastSummary = s.summaries[s.summaries.length - 1];
      const coveredUpTo = lastSummary ? lastSummary.coveredUpTo : -1;
      const oldMessages = coveredUpTo >= 0 ? s.messages.slice(0, coveredUpTo + 1) : [];
      const recentMessages = coveredUpTo >= 0 ? s.messages.slice(coveredUpTo + 1) : s.messages;
      const renderMsg = (msg) => {
        const isEditing = this._editingMsgId === msg.id;
        if (msg.role === 'user') {
          if (isEditing) {
            return `<div class="fl-msg-user" data-msg-id="${msg.id}">
              <div style="max-width:80%;width:100%;">
                <textarea class="fl-edit-textarea" id="fl-edit-textarea">${esc(msg.text)}</textarea>
                <div class="fl-edit-actions">
                  <button class="fl-btn fl-btn-ghost fl-btn-sm" id="fl-edit-cancel">取消</button>
                  <button class="fl-btn fl-btn-primary fl-btn-sm" id="fl-edit-save">保存</button>
                </div>
              </div>
            </div>`;
          }
          return `<div class="fl-msg-user" data-msg-id="${msg.id}">
            <button class="fl-edit-btn" data-edit-id="${msg.id}">编辑</button>
            <div class="bubble">▸ ${esc(msg.text)}</div>
          </div>`;
        }
        let out = '';
        if (msg.parseError) {
          out += `<div class="fl-error-box">内容解析失败，原始输出：<pre>${esc(msg.text)}</pre></div>`;
        }
        if (isEditing) {
          out += `<div data-msg-id="${msg.id}">
            <textarea class="fl-edit-textarea" id="fl-edit-textarea">${esc(msg.text)}</textarea>
            <div class="fl-edit-actions">
              <button class="fl-btn fl-btn-ghost fl-btn-sm" id="fl-edit-cancel">取消</button>
              <button class="fl-btn fl-btn-primary fl-btn-sm" id="fl-edit-save">保存</button>
            </div>
          </div>`;
        } else if (msg.segments && msg.segments.length > 0) {
          msg.segments.forEach(seg => {
            if (seg.type === 'narration') {
              out += `<div class="fl-msg-narration" data-msg-id="${msg.id}">
                <button class="fl-edit-btn" data-edit-id="${msg.id}">编辑</button>
                ${esc(seg.text)}
              </div>`;
            } else {
              const matchedChar = this._getCharByName(seg.character);
              out += `<div class="fl-msg-dialogue" data-msg-id="${msg.id}">
                <button class="fl-edit-btn" data-edit-id="${msg.id}">编辑</button>
                ${this._renderCharAvatar(matchedChar, seg.character || '')}
                <div class="fl-dialogue-name">${esc(seg.character || '')}</div>
                ${seg.action ? `<div class="fl-msg-action">${esc(seg.action)}</div>` : ''}
                <div class="fl-msg-text">「${esc(seg.text)}」</div>
              </div>`;
            }
          });
        } else if (msg.text) {
          out += `<div class="fl-msg-narration" data-msg-id="${msg.id}">
            <button class="fl-edit-btn" data-edit-id="${msg.id}">编辑</button>
            ${esc(msg.text)}
          </div>`;
        }
        return out;
      };
      if (oldMessages.length > 0) {
        const expanded = this._showOldMessages;
        html += `<button class="fl-old-toggle ${expanded?'expanded':''}" id="fl-old-toggle">
          <span class="line"></span>
          <span class="arrow">▼</span>
          <span>${expanded ? '收起早期故事' : `${oldMessages.length} 条早期消息已折叠`}</span>
          <span class="line"></span>
        </button>`;
        if (expanded) {
          html += `<div class="fl-old-messages">`;
          oldMessages.forEach(msg => { html += renderMsg(msg); });
          html += `</div>`;
        }
      }
      recentMessages.forEach(msg => { html += renderMsg(msg); });
      if (s.pendingOpening && s.messages.length === 0 && !this.loading) {
        const po = s.pendingOpening;
        if (po.parseError) {
          html += `<div class="fl-error-box">世界观生成内容解析失败，原始输出：<pre>${esc(po.rawText || po.openingText)}</pre></div>`;
        }
        if (po.openingSegments && po.openingSegments.length > 0) {
          po.openingSegments.forEach(seg => {
            if (seg.type === 'narration') {
              html += `<div class="fl-msg-narration">${esc(seg.text)}</div>`;
            } else {
              const matchedChar = this._getCharByName(seg.character);
              html += `<div class="fl-msg-dialogue">
                ${this._renderCharAvatar(matchedChar, seg.character || '')}
                <div class="fl-dialogue-name">${esc(seg.character || '')}</div>
                ${seg.action ? `<div class="fl-msg-action">${esc(seg.action)}</div>` : ''}
                <div class="fl-msg-text">「${esc(seg.text)}」</div>
              </div>`;
            }
          });
        }
      }
      if (!isArchived) {
        if (s.pendingOpening && s.messages.length === 0 && !this.loading) {
          html += `<div style="display:flex;gap:12px;margin-top:16px;">
            <button class="fl-btn fl-btn-ghost" id="fl-regen-world">重新生成</button>
            <button class="fl-btn fl-btn-primary" style="flex:1;" id="fl-enter-dream">进入浮生</button>
          </div>`;
        } else if (s.messages.length === 0) {
          if (this.loading) {
            html += '<div class="fl-loading-center"><span class="fl-spinner"></span>正在造梦…</div>';
          } else {
            html += '<div style="text-align:center;margin-top:16px;"><div style="color:rgba(239,68,68,0.7);font-size:13px;margin-bottom:12px;">世界观生成失败，请重试</div><button class="fl-btn fl-btn-primary" id="fl-retry-world">重新生成世界观</button></div>';
          }
        } else {
          const last = s.messages[s.messages.length - 1];
          const isLastNarrator = last && last.role === 'narrator';
          const hasChoices = isLastNarrator && last.choices && last.choices.length > 0;
          if (isLastNarrator && !this.loading && s.messages.length >= 2) {
            html += `<div class="fl-regen-row">
              <button class="fl-regen-btn" id="fl-regen">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6M1 20v-6h6" /><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" /></svg>
                重新生成
              </button>
            </div>`;
          }
          if (hasChoices && !this.loading) {
            if (last.isEnding) {
              html += `<div class="fl-ending">
                <div class="fl-ending-text">故 事 似 乎 走 到 了 尾 声</div>
                <button class="fl-archive-btn" id="fl-archive">封存这段浮生</button>
                <div class="fl-ending-or">或 者 ， 继 续 书 写</div>
              </div>`;
            } else {
              html += `<div class="fl-choices-wrapper">
                <div class="fl-choices-label">你 的 选 择</div>
                <div class="fl-choices">`;
              last.choices.forEach(c => {
                html += `<button class="fl-choice-btn" data-choice-id="${c.id}">
                  <span class="fl-choice-text">${esc(c.text)}</span>
                  ${c.tag ? `<span class="fl-choice-tag">${esc(c.tag)}</span>` : ''}
                </button>`;
              });
              html += `</div></div>`;
            }
            const sendDisabled = this._freeText.trim() ? '' : 'disabled';
            html += `<div class="fl-free-input">
              <textarea id="fl-free" placeholder="或者，写下你想做的事…" rows="1">${esc(this._freeText)}</textarea>
              <button class="fl-free-send" id="fl-free-send" ${sendDisabled}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" /></svg>
              </button>
            </div>`;
          } else if (this.loading) {
            html += '<div class="fl-loading"><span class="fl-spinner"></span>落笔中…</div>';
          } else if (last && last.role === 'user') {
            html += `<div class="fl-error-box">故事推进失败，请重试。</div>
            <div style="display:flex;gap:12px;margin-top:12px;">
              <button class="fl-btn fl-btn-primary" style="flex:1;" id="fl-retry-advance">重新生成</button>
            </div>`;
          }
        }
      }
      html += '<div class="fl-bottom-anchor"></div>';
      html += '</div>';
      this.pageEl.innerHTML = html;
      requestAnimationFrame(() => this._restoreScroll());
      if (!isArchived) this._setupScrollButton();
      this.pageEl.querySelector('#fl-story-back').onclick = () => {
        this.sessionId = null; this._scrollTop = 0; this._showOldMessages = false; this._freeText = ''; this._pickedChoiceId = null; this._pickedChoiceText = ''; this._editingMsgId = null; this.page = 'list'; this.render();
      };
      this.pageEl.querySelector('#fl-delete').onclick = async () => {
        const ok = await this.roche.ui.confirm({ title:'确认删除', message:'确定删除这场梦吗？此操作不可撤销。' });
        if (ok) { this.deleteSession(this.sessionId); this.sessionId=null; this._scrollTop=0; this.page='list'; this.render(); }
      };
      const archiveHeader = this.pageEl.querySelector('#fl-archive-header');
      if (archiveHeader) archiveHeader.onclick = () => this._archiveFlow();
      const enterBtn = this.pageEl.querySelector('#fl-enter-dream');
      if (enterBtn) enterBtn.onclick = () => { this.confirmOpening(this.sessionId); this._scrollTop = 0; this.render(); };
      const regenWorld = this.pageEl.querySelector('#fl-regen-world');
      if (regenWorld) regenWorld.onclick = () => this._genWorldFlow();
      const retryWorld = this.pageEl.querySelector('#fl-retry-world');
      if (retryWorld) retryWorld.onclick = () => this._genWorldFlow();
      const oldToggle = this.pageEl.querySelector('#fl-old-toggle');
      if (oldToggle) oldToggle.onclick = () => {
        this._saveScroll();
        this._showOldMessages = !this._showOldMessages;
        this.render();
      };
      // 编辑按钮事件
      this.pageEl.querySelectorAll('.fl-edit-btn').forEach(btn => {
        btn.onclick = (e) => {
          e.stopPropagation();
          this._editingMsgId = btn.dataset.editId;
          this._saveScroll();
          this.render();
          requestAnimationFrame(() => {
            const ta = this.pageEl.querySelector('#fl-edit-textarea');
            if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
          });
        };
      });
      const editCancel = this.pageEl.querySelector('#fl-edit-cancel');
      if (editCancel) editCancel.onclick = () => { this._editingMsgId = null; this.render(); };
      const editSave = this.pageEl.querySelector('#fl-edit-save');
      if (editSave) editSave.onclick = () => {
        const ta = this.pageEl.querySelector('#fl-edit-textarea');
        if (!ta) return;
        const newText = ta.value.trim();
        if (!newText) { this.roche.ui.toast('内容不能为空'); return; }
        const s = this.getSession(this.sessionId);
        if (!s) return;
        const msgIndex = s.messages.findIndex(m => m.id === this._editingMsgId);
        if (msgIndex === -1) return;
        const updatedMessages = [...s.messages];
        const msg = updatedMessages[msgIndex];
        if (msg.role === 'narrator' && msg.segments && msg.segments.length > 0) {
          // 对于叙述者消息，如果有多个segments，更新第一个narration的文本
          const firstNarration = msg.segments.findIndex(seg => seg.type === 'narration');
          if (firstNarration >= 0) {
            updatedMessages[msgIndex] = { ...msg, text: newText, segments: msg.segments.map((seg, i) => i === firstNarration ? { ...seg, text: newText } : seg) };
          } else {
            updatedMessages[msgIndex] = { ...msg, text: newText };
          }
        } else {
          updatedMessages[msgIndex] = { ...msg, text: newText };
        }
        this.updateSession(this.sessionId, { messages: updatedMessages });
        this._editingMsgId = null;
        this.roche.ui.toast('已保存编辑');
        this.render();
      };
      this.pageEl.querySelectorAll('.fl-choice-btn').forEach(btn => {
        btn.onclick = () => {
          const id = btn.dataset.choiceId;
          const text = btn.querySelector('.fl-choice-text').textContent;
          this._saveScroll();
          this._pickedChoiceId = id;
          this._pickedChoiceText = text;
          this._freeText = text;
          this.render();
          requestAnimationFrame(() => {
            this._restoreScroll();
            const inp = this.pageEl && this.pageEl.querySelector('#fl-free');
            if (inp) {
              inp.focus();
              inp.setSelectionRange(inp.value.length, inp.value.length);
              inp.style.height = 'auto';
              inp.style.height = Math.min(inp.scrollHeight, 120) + 'px';
            }
          });
        };
      });
      const freeInput = this.pageEl.querySelector('#fl-free');
      const freeSend = this.pageEl.querySelector('#fl-free-send');
      if (freeInput) {
        freeInput.style.height = 'auto';
        freeInput.style.height = Math.min(freeInput.scrollHeight, 120) + 'px';
        freeInput.oninput = () => {
          this._freeText = freeInput.value;
          freeInput.style.height = 'auto';
          freeInput.style.height = Math.min(freeInput.scrollHeight, 120) + 'px';
          if (freeSend) freeSend.disabled = !this._freeText.trim();
          if (this._pickedChoiceId != null && freeInput.value !== this._pickedChoiceText) {
            this._pickedChoiceId = null;
            this._pickedChoiceText = '';
          }
        };
        freeInput.onkeydown = e => {};
      }
      if (freeSend) freeSend.onclick = () => this._sendFreeText();
      const retryAdvance = this.pageEl.querySelector('#fl-retry-advance');
      if (retryAdvance) retryAdvance.onclick = () => {
        if (this.loading) return;
        const s = this.getSession(this.sessionId);
        if (!s) return;
        const lastUser = [...s.messages].reverse().find(m => m.role === 'user');
        if (!lastUser) return;
        this._saveScroll();
        this.loading = true;
        this.render();
        (async () => {
          try {
            await this.advanceStory(this.sessionId, lastUser.text, lastUser.choiceId, true);
          } catch(e) {
            this.roche.ui.toast('故事推进失败：'+e.message);
          } finally {
            this.loading = false;
            this.render();
          }
        })();
      };
      const regen = this.pageEl.querySelector('#fl-regen');
      if (regen) regen.onclick = () => this._regenFlow();
      const archiveBtn = this.pageEl.querySelector('#fl-archive');
      if (archiveBtn) archiveBtn.onclick = () => this._archiveFlow();
    }
    async _genWorldFlow() {
      if (this.loading) return;
      this.loading = true; this._scrollTop = 0; this.render();
      try { await this.generateWorld(this.sessionId); }
      catch(e) { this.roche.ui.toast('世界观生成失败：'+e.message); }
      finally { this.loading = false; this.render(); }
    }
    _sendFreeText() {
      const t = this._freeText.trim();
      if (!t) return;
      const choiceId = (this._pickedChoiceId != null && t === this._pickedChoiceText) ? this._pickedChoiceId : undefined;
      this._pickedChoiceId = null;
      this._pickedChoiceText = '';
      this._advanceFlow(t, choiceId);
    }
    async _advanceFlow(text, choiceId) {
      if (this.loading) return;
      this._saveScroll();
      const s = this.getSession(this.sessionId);
      if (s) {
        const userMsg = {
          id: generateId('msg'),
          role: 'user',
          text: text,
          choiceId: choiceId ?? undefined,
          timestamp: Date.now()
        };
        this.updateSession(this.sessionId, { messages: [...s.messages, userMsg] });
      }
      this._freeText = '';
      this._pickedChoiceId = null;
      this._pickedChoiceText = '';
      this.loading = true;
      this.render();
      requestAnimationFrame(() => {
        const body = this.pageEl && this.pageEl.querySelector('.fl-body');
        if (body) body.scrollTop = body.scrollHeight;
      });
      try {
        await this.advanceStory(this.sessionId, text, choiceId, true);
      }
      catch(e) {
        this.roche.ui.toast('故事推进失败：'+e.message);
      }
      finally {
        this.loading = false;
        this.render();
      }
    }
    async _regenFlow() {
      if (this.loading) return;
      this._saveScroll();
      const s = this.getSession(this.sessionId);
      if (!s) return;
      const msgs = s.messages;
      if (msgs.length < 2 || msgs[msgs.length-1].role !== 'narrator' || msgs[msgs.length-2].role !== 'user') {
        this.roche.ui.toast('没有可重新生成的内容');
        return;
      }
      const lastUserMsg = msgs[msgs.length-2];
      this.updateSession(this.sessionId, { messages: msgs.slice(0, -1) });
      this.loading = true;
      this.render();
      try {
        await this.advanceStory(this.sessionId, lastUserMsg.text, lastUserMsg.choiceId, true);
      }
      catch(e) {
        this.updateSession(this.sessionId, { messages: msgs });
        this.roche.ui.toast('重新生成失败：'+e.message);
      }
      finally {
        this.loading = false;
        this.render();
      }
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
    version: '4.2.0',
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
