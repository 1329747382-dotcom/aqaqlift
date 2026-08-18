/**
 * 浮生 (FloatingLife) - Roche 全信任 JS 插件 v3.0
 * 一场醒来就忘的梦
 * UI 深度还原自 Echoes v4 浮生功能
 *
 * v3.0 更新：
 * - 修复 iOS 上下白边（position:fixed 全屏覆盖 + safe-area 适配）
 * - 字体大小与颜色深度还原原件
 * - 修复创建页点击回滚顶部
 * - 恢复雨滴效果
 * - 移除进入浮生后自动滚动到底部
 * - 故事页移除世界观卡片，添加角色头像，还原对话样式
 * - 新增右下角滚动到底部按钮
 * - 改进 AI 生成错误处理（解析失败保留原始内容）
 * - 选项默认展开，置于内容流底部
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
      catch (e2) {
        // 解析失败时抛出原始文本，供上层降级处理
        const err = new Error(`浮生：${context}返回的内容无法解析为 JSON`);
        err.rawText = text;
        throw err;
      }
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
      const lore = (worldBooks || []).filter(w =>
        (w.categoryId === 'lore' || w.category === 'lore') &&
        mountedIds.has(w.id) && selectedWBIds.includes(w.id)
      );
      if (lore.length > 0) { lines.push('补充背景知识：'); lore.forEach(w => lines.push(`- ${w.title || w.name}：${w.content || w.text}`)); }
      if (personaText) lines.push(`人设：${personaText}`);
      const patches = (worldBooks || []).filter(w =>
        (w.categoryId === 'patch' || w.category === 'patch') &&
        mountedIds.has(w.id) && selectedWBIds.includes(w.id)
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
      this.selWBIds = [];
      this.selPerspective = 'third-limited';
      this.draftTheme = '';
      this.loading = false;
      this.styleEl = null;
      this._scrollTop = 0; // 保存滚动位置
      this._scrollBtn = null; // 滚动到底部按钮
      this._onScroll = null; // scroll事件引用
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
    }

    async _save() { try { await this.roche.storage.set(STORAGE_KEY, this.sessions); } catch(e) {} }

    _injectStyles() {
      this.styleEl = document.createElement('style');
      this.styleEl.textContent = `
        /* ===== 根容器：fixed 全屏覆盖，延伸到安全区域后面 ===== */
        .roche-plugin-floating-life {
          position: fixed; top: 0; left: 0; right: 0; bottom: 0;
          width: 100%; height: 100%;
          background: linear-gradient(180deg, #141821 0%, #0d1017 100%);
          color: #cbd5e1;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
          overflow: hidden; box-sizing: border-box;
          display: flex; flex-direction: column;
          padding-top: env(safe-area-inset-top, 0px);
          padding-bottom: env(safe-area-inset-bottom, 0px);
          z-index: 9999;
        }
        .roche-plugin-floating-life * { box-sizing: border-box; }

        /* ===== 雨滴背景 ===== */
        .roche-plugin-floating-life .fl-rain {
          position: absolute; inset: 0; z-index: 0;
          overflow: hidden; pointer-events: none;
        }
        .roche-plugin-floating-life .fl-drop {
          position: absolute;
          background: rgba(147, 197, 253, 0.5);
          border-radius: 9999px;
          animation: fl-rain linear infinite;
        }
        @keyframes fl-rain {
          0% { transform: translateY(-20px); opacity: 0; }
          10% { opacity: var(--op); }
          90% { opacity: var(--op); }
          100% { transform: translateY(100vh); opacity: 0; }
        }

        /* ===== Header ===== */
        .roche-plugin-floating-life .fl-header {
          flex-shrink: 0; padding: 12px 16px 10px;
          background: rgba(20, 24, 33, 0.82);
          backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
          border-bottom: 1px solid rgba(255, 255, 255, 0.04);
          position: relative; z-index: 10;
        }
        .roche-plugin-floating-life .fl-header-row {
          display: flex; align-items: center; gap: 8px;
        }
        .roche-plugin-floating-life .fl-icon-btn {
          padding: 6px; border-radius: 9999px;
          background: transparent; border: none;
          color: rgba(148, 163, 184, 0.55);
          cursor: pointer; transition: all .2s;
          display: flex; align-items: center; justify-content: center;
          flex-shrink: 0;
        }
        .roche-plugin-floating-life .fl-icon-btn:hover {
          background: rgba(255, 255, 255, 0.06); color: #94a3b8;
        }
        .roche-plugin-floating-life .fl-header-center { flex: 1; min-width: 0; }
        .roche-plugin-floating-life .fl-title {
          font-size: 22px; font-weight: 700;
          color: rgba(219, 234, 254, 0.8);
          letter-spacing: 0.02em; line-height: 1.2;
        }
        .roche-plugin-floating-life .fl-title-sm {
          font-size: 17px; font-weight: 600;
          color: rgba(219, 234, 254, 0.75);
          font-family: "Songti SC", "SimSun", serif;
          letter-spacing: 0.025em; line-height: 1.3;
        }
        .roche-plugin-floating-life .fl-subtitle {
          font-size: 11px; color: rgba(148, 163, 184, 0.5);
          margin-top: 2px; letter-spacing: 0.05em;
        }
        .roche-plugin-floating-life .fl-keywords {
          display: flex; gap: 5px; flex-wrap: wrap; margin-top: 5px;
        }
        .roche-plugin-floating-life .fl-keyword {
          padding: 2px 7px;
          background: rgba(255, 255, 255, 0.035);
          border: 1px solid rgba(255, 255, 255, 0.05);
          border-radius: 5px; font-size: 10px;
          color: rgba(148, 163, 184, 0.5);
        }
        .roche-plugin-floating-life .fl-archive-btn-sm {
          padding: 5px 12px; font-size: 12px;
          color: rgba(191, 219, 254, 0.5);
          background: transparent;
          border: 1px solid rgba(191, 219, 254, 0.12);
          border-radius: 8px; cursor: pointer; transition: all .2s;
          flex-shrink: 0; font-family: "Songti SC", "SimSun", serif;
        }
        .roche-plugin-floating-life .fl-archive-btn-sm:hover {
          background: rgba(191, 219, 254, 0.05);
          color: rgba(191, 219, 254, 0.7);
        }

        /* ===== Body 滚动区 ===== */
        .roche-plugin-floating-life .fl-body {
          flex: 1; overflow-y: auto;
          padding: 16px 20px 20px;
          -webkit-overflow-scrolling: touch;
          position: relative; z-index: 1;
        }
        .roche-plugin-floating-life .fl-body::-webkit-scrollbar { width: 0; }

        /* ===== 分类分组 ===== */
        .roche-plugin-floating-life .fl-group { margin-bottom: 24px; }
        .roche-plugin-floating-life .fl-group-header {
          display: flex; align-items: center; gap: 7px;
          margin-bottom: 12px; padding: 0 2px;
        }
        .roche-plugin-floating-life .fl-group-icon {
          width: 16px; height: 16px;
          color: rgba(148, 163, 184, 0.45); flex-shrink: 0;
        }
        .roche-plugin-floating-life .fl-group-title {
          font-size: 14px; font-weight: 600;
          color: rgba(203, 213, 225, 0.6); letter-spacing: 0.05em;
        }

        /* ===== 会话卡片 ===== */
        .roche-plugin-floating-life .fl-session-card {
          width: 100%; padding: 16px 18px;
          background: rgba(255, 255, 255, 0.022);
          border: 1px solid rgba(255, 255, 255, 0.055);
          border-radius: 12px; text-align: left; cursor: pointer;
          transition: all .25s; margin-bottom: 10px; position: relative;
        }
        .roche-plugin-floating-life .fl-session-card:hover {
          background: rgba(255, 255, 255, 0.04);
          border-color: rgba(255, 255, 255, 0.09);
        }
        .roche-plugin-floating-life .fl-card-top {
          display: flex; align-items: flex-start;
          justify-content: space-between; gap: 10px;
        }
        .roche-plugin-floating-life .fl-card-title {
          font-size: 16px; font-weight: 600;
          color: rgba(226, 232, 240, 0.85);
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
          flex: 1; min-width: 0;
        }
        .roche-plugin-floating-life .fl-card-date {
          font-size: 11px; color: rgba(100, 116, 139, 0.6);
          flex-shrink: 0; padding-top: 3px;
        }
        .roche-plugin-floating-life .fl-card-chars {
          font-size: 12px; color: rgba(148, 163, 184, 0.55);
          margin-top: 5px;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .roche-plugin-floating-life .fl-card-meta {
          display: flex; align-items: center;
          justify-content: space-between; margin-top: 7px;
        }
        .roche-plugin-floating-life .fl-card-status {
          font-size: 11px; color: rgba(100, 116, 139, 0.6);
        }
        .roche-plugin-floating-life .fl-card-delete {
          padding: 4px 5px; background: transparent; border: none;
          color: rgba(100, 116, 139, 0.45); cursor: pointer;
          border-radius: 6px; transition: all .2s;
          display: flex; align-items: center;
        }
        .roche-plugin-floating-life .fl-card-delete:hover {
          color: rgba(239, 68, 68, 0.65);
          background: rgba(239, 68, 68, 0.05);
        }
        .roche-plugin-floating-life .fl-card-verdict {
          font-size: 12px; color: rgba(191, 219, 254, 0.3);
          margin-top: 8px;
          font-family: "Songti SC", "SimSun", serif;
          font-style: italic; line-height: 1.5;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .roche-plugin-floating-life .fl-card-archived-tag {
          display: inline-block; margin-top: 6px;
          padding: 2px 7px;
          background: rgba(191, 219, 254, 0.04);
          border: 1px solid rgba(191, 219, 254, 0.08);
          border-radius: 4px; font-size: 10px;
          color: rgba(191, 219, 254, 0.35); letter-spacing: 0.1em;
        }

        /* ===== 空状态 ===== */
        .roche-plugin-floating-life .fl-empty {
          display: flex; flex-direction: column;
          align-items: center; justify-content: center;
          text-align: center; gap: 12px; padding: 48px 16px;
        }
        .roche-plugin-floating-life .fl-empty-icon {
          width: 42px; height: 42px; color: rgba(51, 65, 85, 0.5);
        }
        .roche-plugin-floating-life .fl-empty-title {
          font-size: 14px; color: rgba(148, 163, 184, 0.55); font-weight: 500;
        }
        .roche-plugin-floating-life .fl-empty-desc {
          font-size: 12px; color: rgba(100, 116, 139, 0.5); margin-top: 2px;
        }

        /* ===== 按钮 ===== */
        .roche-plugin-floating-life .fl-btn {
          display: inline-flex; align-items: center; justify-content: center;
          gap: 6px; padding: 10px 20px; border: none;
          border-radius: 10px; font-size: 13px; cursor: pointer;
          transition: all .2s; font-weight: 500;
        }
        .roche-plugin-floating-life .fl-btn-primary {
          background: rgba(255, 255, 255, 0.07);
          color: rgba(226, 232, 240, 0.85);
          border: 1px solid rgba(255, 255, 255, 0.09);
        }
        .roche-plugin-floating-life .fl-btn-primary:hover {
          background: rgba(255, 255, 255, 0.12);
        }
        .roche-plugin-floating-life .fl-btn-primary:disabled {
          opacity: 0.3; pointer-events: none;
        }
        .roche-plugin-floating-life .fl-btn-ghost {
          background: transparent;
          color: rgba(148, 163, 184, 0.55);
          border: 1px solid rgba(255, 255, 255, 0.07);
        }
        .roche-plugin-floating-life .fl-btn-ghost:hover {
          background: rgba(255, 255, 255, 0.04); color: #94a3b8;
        }
        .roche-plugin-floating-life .fl-btn-block { width: 100%; }

        /* ===== 创建页 ===== */
        .roche-plugin-floating-life .fl-section-label {
          font-size: 12px; color: rgba(148, 163, 184, 0.55);
          margin-bottom: 12px; letter-spacing: 0.05em; font-weight: 500;
        }
        .roche-plugin-floating-life .fl-char-item {
          width: 100%; padding: 12px 14px;
          background: rgba(255, 255, 255, 0.022);
          border: 1px solid rgba(255, 255, 255, 0.055);
          border-radius: 10px; text-align: left; cursor: pointer;
          transition: all .2s; display: flex; align-items: center;
          gap: 10px; margin-bottom: 8px;
        }
        .roche-plugin-floating-life .fl-char-item:hover {
          background: rgba(255, 255, 255, 0.04);
        }
        .roche-plugin-floating-life .fl-char-item.active {
          background: rgba(147, 197, 253, 0.05);
          border-color: rgba(147, 197, 253, 0.22);
        }
        .roche-plugin-floating-life .fl-char-avatar {
          width: 34px; height: 34px; border-radius: 9999px;
          flex-shrink: 0; display: flex; align-items: center;
          justify-content: center; font-size: 13px; font-weight: 600;
          overflow: hidden;
        }
        .roche-plugin-floating-life .fl-char-avatar img {
          width: 100%; height: 100%; object-fit: cover;
        }
        .roche-plugin-floating-life .fl-char-name {
          font-size: 13px; color: rgba(203, 213, 225, 0.8);
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;
        }
        .roche-plugin-floating-life .fl-char-check {
          width: 18px; height: 18px; border-radius: 9999px;
          border: 1.5px solid rgba(255, 255, 255, 0.13);
          flex-shrink: 0; display: flex; align-items: center;
          justify-content: center; transition: all .2s;
        }
        .roche-plugin-floating-life .fl-char-item.active .fl-char-check {
          background: rgba(147, 197, 253, 0.75);
          border-color: rgba(147, 197, 253, 0.75);
        }
        .roche-plugin-floating-life .fl-char-check svg { opacity: 0; transition: opacity .2s; }
        .roche-plugin-floating-life .fl-char-item.active .fl-char-check svg { opacity: 1; }

        .roche-plugin-floating-life .fl-persp-item {
          width: 100%; padding: 12px 14px;
          background: rgba(255, 255, 255, 0.022);
          border: 1px solid rgba(255, 255, 255, 0.055);
          border-radius: 10px; text-align: left; cursor: pointer;
          transition: all .2s; margin-bottom: 8px;
        }
        .roche-plugin-floating-life .fl-persp-item:hover {
          background: rgba(255, 255, 255, 0.04);
        }
        .roche-plugin-floating-life .fl-persp-item.active {
          background: rgba(147, 197, 253, 0.05);
          border-color: rgba(147, 197, 253, 0.22);
        }
        .roche-plugin-floating-life .fl-persp-label {
          font-size: 13px; color: rgba(203, 213, 225, 0.8); font-weight: 500;
        }
        .roche-plugin-floating-life .fl-persp-desc {
          font-size: 11px; color: rgba(148, 163, 184, 0.5);
          margin-top: 3px; font-family: "Songti SC", "SimSun", serif;
        }

        /* ===== 世界书选择 ===== */
        .roche-plugin-floating-life .fl-wb-group { margin-bottom: 14px; }
        .roche-plugin-floating-life .fl-wb-cat-title {
          font-size: 11px; color: rgba(100, 116, 139, 0.6);
          margin-bottom: 7px; padding: 0 2px; letter-spacing: 0.05em;
        }
        .roche-plugin-floating-life .fl-wb-item {
          width: 100%; padding: 9px 12px;
          background: rgba(255, 255, 255, 0.018);
          border: 1px solid rgba(255, 255, 255, 0.045);
          border-radius: 8px; text-align: left; cursor: pointer;
          transition: all .2s; display: flex; align-items: center;
          gap: 8px; margin-bottom: 5px;
        }
        .roche-plugin-floating-life .fl-wb-item:hover {
          background: rgba(255, 255, 255, 0.035);
        }
        .roche-plugin-floating-life .fl-wb-item.active {
          background: rgba(147, 197, 253, 0.04);
          border-color: rgba(147, 197, 253, 0.18);
        }
        .roche-plugin-floating-life .fl-wb-check {
          width: 15px; height: 15px; border-radius: 4px;
          border: 1.5px solid rgba(255, 255, 255, 0.13);
          flex-shrink: 0; display: flex; align-items: center;
          justify-content: center; transition: all .2s;
        }
        .roche-plugin-floating-life .fl-wb-item.active .fl-wb-check {
          background: rgba(147, 197, 253, 0.75);
          border-color: rgba(147, 197, 253, 0.75);
        }
        .roche-plugin-floating-life .fl-wb-check svg { opacity: 0; transition: opacity .2s; }
        .roche-plugin-floating-life .fl-wb-item.active .fl-wb-check svg { opacity: 1; }
        .roche-plugin-floating-life .fl-wb-name {
          font-size: 12px; color: rgba(203, 213, 225, 0.7);
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;
        }
        .roche-plugin-floating-life .fl-wb-hint {
          font-size: 11px; color: rgba(100, 116, 139, 0.55);
          margin-bottom: 10px; padding: 0 2px; line-height: 1.5;
        }

        .roche-plugin-floating-life input,
        .roche-plugin-floating-life textarea {
          width: 100%; padding: 10px 14px;
          background: rgba(255, 255, 255, 0.022);
          border: 1px solid rgba(255, 255, 255, 0.055);
          border-radius: 10px; color: rgba(203, 213, 225, 0.8);
          font-size: 13px; outline: none;
          transition: border-color .2s; font-family: inherit;
        }
        .roche-plugin-floating-life input:focus {
          border-color: rgba(147, 197, 253, 0.25);
        }
        .roche-plugin-floating-life input::placeholder {
          color: rgba(100, 116, 139, 0.5);
        }

        .roche-plugin-floating-life .fl-footer {
          flex-shrink: 0; padding: 12px 20px 16px;
          border-top: 1px solid rgba(255, 255, 255, 0.035);
          background: rgba(20, 24, 33, 0.5);
        }

        /* ===== 故事页 - 旁白 ===== */
        .roche-plugin-floating-life .fl-msg-narration {
          font-size: 13px; line-height: 2;
          color: rgba(203, 213, 225, 0.65);
          font-family: "Songti SC", "SimSun", serif;
          text-indent: 2em; text-align: justify;
          margin-bottom: 12px;
        }

        /* ===== 故事页 - 对话（带角色头像） ===== */
        .roche-plugin-floating-life .fl-msg-dialogue {
          margin: 16px 0; text-align: center;
        }
        .roche-plugin-floating-life .fl-dialogue-avatar {
          width: 44px; height: 44px; border-radius: 9999px;
          margin: 0 auto 6px; overflow: hidden;
          border: 1.5px solid rgba(255, 255, 255, 0.08);
          display: flex; align-items: center; justify-content: center;
          font-size: 16px; font-weight: 600;
        }
        .roche-plugin-floating-life .fl-dialogue-avatar img {
          width: 100%; height: 100%; object-fit: cover;
        }
        .roche-plugin-floating-life .fl-dialogue-name {
          font-size: 12px; color: rgba(147, 197, 253, 0.5);
          margin-bottom: 8px; letter-spacing: 0.05em;
        }
        .roche-plugin-floating-life .fl-msg-action {
          font-size: 13px; color: rgba(129, 140, 248, 0.45);
          font-style: italic; line-height: 1.8;
          font-family: "Songti SC", "SimSun", serif;
          margin-bottom: 4px;
        }
        .roche-plugin-floating-life .fl-msg-text {
          font-size: 14px; line-height: 1.9;
          color: rgba(226, 232, 240, 0.88);
          font-family: "Songti SC", "SimSun", serif;
          text-align: left; display: inline-block;
          max-width: 100%;
        }

        /* ===== 用户消息 ===== */
        .roche-plugin-floating-life .fl-msg-user {
          display: flex; justify-content: flex-end; margin: 12px 0;
        }
        .roche-plugin-floating-life .fl-msg-user .bubble {
          max-width: 80%; padding: 8px 14px;
          background: rgba(96, 165, 250, 0.04);
          border: 1px solid rgba(147, 197, 253, 0.08);
          border-radius: 10px; font-size: 12px;
          color: rgba(191, 219, 254, 0.45);
          font-family: "Songti SC", "SimSun", serif; line-height: 1.6;
        }

        /* ===== 选项区域 ===== */
        .roche-plugin-floating-life .fl-choices-wrapper {
          margin-top: 20px; padding-top: 16px;
          border-top: 1px solid rgba(255, 255, 255, 0.035);
        }
        .roche-plugin-floating-life .fl-choices-label {
          font-size: 10px; color: rgba(100, 116, 139, 0.5);
          letter-spacing: 0.25em; text-align: center; margin-bottom: 12px;
        }
        .roche-plugin-floating-life .fl-choices {
          display: flex; flex-direction: column; gap: 8px;
        }
        .roche-plugin-floating-life .fl-choice-btn {
          width: 100%; padding: 12px 16px;
          background: rgba(255, 255, 255, 0.018);
          border: 1px solid rgba(255, 255, 255, 0.05);
          border-radius: 10px; text-align: left; cursor: pointer;
          transition: all .2s; display: flex; align-items: center;
          justify-content: space-between; gap: 10px;
        }
        .roche-plugin-floating-life .fl-choice-btn:hover:not(:disabled) {
          background: rgba(255, 255, 255, 0.05);
          border-color: rgba(147, 197, 253, 0.18);
          transform: translateX(2px);
        }
        .roche-plugin-floating-life .fl-choice-btn:disabled {
          opacity: 0.3; pointer-events: none;
        }
        .roche-plugin-floating-life .fl-choice-text {
          font-size: 12px; color: rgba(148, 163, 184, 0.7);
          font-family: "Songti SC", "SimSun", serif; line-height: 1.5; flex: 1;
        }
        .roche-plugin-floating-life .fl-choice-tag {
          font-size: 9px; color: rgba(100, 116, 139, 0.6);
          flex-shrink: 0; padding: 2px 6px;
          background: rgba(255, 255, 255, 0.025);
          border-radius: 5px; letter-spacing: 0.05em;
        }

        .roche-plugin-floating-life .fl-free-input {
          display: flex; gap: 8px; margin-top: 12px;
        }
        .roche-plugin-floating-life .fl-free-input input {
          flex: 1; margin-bottom: 0; border-style: dashed;
          font-size: 12px; padding: 9px 12px;
        }
        .roche-plugin-floating-life .fl-free-input .fl-btn {
          padding: 0 16px; font-size: 12px;
        }

        .roche-plugin-floating-life .fl-ending {
          text-align: center; margin: 20px 0 14px;
        }
        .roche-plugin-floating-life .fl-ending-text {
          font-size: 11px; color: rgba(191, 219, 254, 0.35);
          letter-spacing: 0.3em;
          font-family: "Songti SC", "SimSun", serif; margin-bottom: 14px;
        }
        .roche-plugin-floating-life .fl-archive-btn {
          padding: 9px 22px; font-size: 12px;
          color: rgba(191, 219, 254, 0.5);
          background: transparent;
          border: 1px solid rgba(191, 219, 254, 0.13);
          border-radius: 10px; cursor: pointer; transition: all .2s;
          font-family: "Songti SC", "SimSun", serif; letter-spacing: 0.15em;
        }
        .roche-plugin-floating-life .fl-archive-btn:hover {
          background: rgba(191, 219, 254, 0.04);
          border-color: rgba(191, 219, 254, 0.22);
          color: rgba(191, 219, 254, 0.7);
        }
        .roche-plugin-floating-life .fl-ending-or {
          font-size: 9px; color: rgba(51, 65, 85, 0.7);
          letter-spacing: 0.2em; margin-top: 12px;
        }

        .roche-plugin-floating-life .fl-verdict {
          text-align: center; padding: 24px 14px;
          margin: 14px 0;
          border-top: 1px solid rgba(255, 255, 255, 0.04);
          border-bottom: 1px solid rgba(255, 255, 255, 0.04);
        }
        .roche-plugin-floating-life .fl-verdict-label {
          font-size: 10px; color: rgba(191, 219, 254, 0.22);
          letter-spacing: 0.5em; margin-bottom: 12px;
        }
        .roche-plugin-floating-life .fl-verdict-text {
          font-size: 15px; line-height: 2;
          color: rgba(219, 234, 254, 0.6);
          font-family: "Songti SC", "SimSun", serif;
          max-width: 280px; margin: 0 auto;
        }

        .roche-plugin-floating-life .fl-loading {
          text-align: center; padding: 24px;
          color: rgba(148, 163, 184, 0.45); font-size: 12px;
        }
        .roche-plugin-floating-life .fl-spinner {
          display: inline-block; width: 14px; height: 14px;
          border: 2px solid rgba(147, 197, 253, 0.12);
          border-top-color: rgba(147, 197, 253, 0.55);
          border-radius: 50%; animation: fl-spin .8s linear infinite;
          vertical-align: middle; margin-right: 7px;
        }
        @keyframes fl-spin { to { transform: rotate(360deg); } }

        .roche-plugin-floating-life .fl-regen-row {
          display: flex; gap: 8px; margin-top: 12px; justify-content: flex-end;
        }

        /* ===== 滚动到底部按钮 ===== */
        .roche-plugin-floating-life .fl-scroll-btn {
          position: absolute; right: 16px; bottom: 24px;
          width: 40px; height: 40px; border-radius: 9999px;
          background: rgba(30, 41, 59, 0.6);
          backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
          border: 1px solid rgba(255, 255, 255, 0.08);
          color: rgba(203, 213, 225, 0.6);
          display: flex; align-items: center; justify-content: center;
          cursor: pointer; z-index: 20;
          opacity: 0; transform: translateY(8px);
          transition: opacity .3s, transform .3s, background .2s;
          pointer-events: none;
        }
        .roche-plugin-floating-life .fl-scroll-btn.visible {
          opacity: 1; transform: translateY(0); pointer-events: auto;
        }
        .roche-plugin-floating-life .fl-scroll-btn:hover {
          background: rgba(30, 41, 59, 0.8);
          color: rgba(226, 232, 240, 0.85);
        }

        /* ===== 错误提示（原始内容降级显示） ===== */
        .roche-plugin-floating-life .fl-parse-error {
          padding: 14px 16px; margin: 12px 0;
          background: rgba(239, 68, 68, 0.04);
          border: 1px solid rgba(239, 68, 68, 0.12);
          border-radius: 10px; font-size: 12px;
          color: rgba(252, 165, 165, 0.7); line-height: 1.7;
        }
        .roche-plugin-floating-life .fl-parse-error pre {
          margin: 8px 0 0; padding: 10px;
          background: rgba(0, 0, 0, 0.2); border-radius: 6px;
          font-size: 11px; color: rgba(203, 213, 225, 0.5);
          white-space: pre-wrap; word-break: break-all;
          max-height: 150px; overflow-y: auto;
        }
      `;
      document.head.appendChild(this.styleEl);
    }

    _createRain() {
      const rain = document.createElement('div');
      rain.className = 'fl-rain';
      for (let i = 0; i < 30; i++) {
        const drop = document.createElement('div');
        drop.className = 'fl-drop';
        drop.style.left = Math.random() * 100 + '%';
        drop.style.top = '0';
        drop.style.width = '1px';
        drop.style.height = (10 + Math.random() * 20) + 'px';
        drop.style.setProperty('--op', (0.04 + Math.random() * 0.08).toString());
        const duration = 1.8 + Math.random() * 2.2;
        drop.style.animationDuration = duration + 's';
        drop.style.animationDelay = (-duration * Math.random()) + 's';
        rain.appendChild(drop);
      }
      return rain;
    }

    destroy() {
      this._removeScrollListener();
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
      const r = await this.roche.ai.chat({
        messages: [
          { role:'system', content: expectJSON ? 'You are a helpful assistant. Please output valid JSON only.' : 'You are a helpful assistant.' },
          { role:'user', content: prompt }
        ],
        temperature: 0.7
      });
      return r.text || r.content || '';
    }

    _getSelectedWBIds(session) {
      return session && Array.isArray(session.selectedWorldBookIds) ? session.selectedWorldBookIds : [];
    }

    _getCharById(id) {
      return this.characters.find(c => c.id === id) || null;
    }

    _getCharAvatar(char, name) {
      if (char && char.avatar) {
        return `<div class="fl-dialogue-avatar"><img src="${esc(char.avatar)}" alt=""></div>`;
      }
      const color = (char && char.avatarColor) || '#64748b';
      const initial = (name || '?')[0];
      return `<div class="fl-dialogue-avatar" style="background:${color}30;color:${color}">${esc(initial)}</div>`;
    }

    async generateWorld(id) {
      const s = this.getSession(id); if (!s) throw new Error('会话不存在');
      const parts = this.characters.filter(c => s.participantIds.includes(c.id));
      const selectedWBIds = this._getSelectedWBIds(s);
      const prompt = buildWorldPrompt({
        user: this.user || {name:'旅人'},
        characters: parts, perspective: s.perspective,
        userTheme: s.userTheme, worldBooks: this.worldBooks, selectedWBIds
      });
      const raw = await this._callAI(prompt, true);
      let d;
      try {
        d = safeParseJSON(raw, '世界观生成');
      } catch (e) {
        // 解析失败：保存原始内容，降级显示
        d = {
          title: '未命名之梦',
          scene: e.rawText || raw || '（世界观生成内容解析失败）',
          characterRoles: {}, userRole: '', conflictSeed: '',
          keywords: [], hiddenArc: '',
          openingSegments: [{ type:'narration', text: e.rawText || raw || '（内容解析失败，请尝试重新生成）' }],
          choices: [],
          _parseError: true,
          _rawText: raw
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

    async advanceStory(id, userInput, choiceId) {
      const s = this.getSession(id); if (!s) throw new Error('会话不存在');
      if (s.status !== 'active') throw new Error('该会话已封存');
      const parts = this.characters.filter(c => s.participantIds.includes(c.id));
      const selectedWBIds = this._getSelectedWBIds(s);
      const userMsg = { id: generateId('msg'), role: 'user', text: userInput, choiceId: choiceId ?? undefined, timestamp: Date.now() };
      const msgs = [...s.messages, userMsg];
      const prompt = buildStoryPrompt({
        session: {...s, messages: msgs},
        user: this.user || {name:'旅人'},
        characters: parts, userInput,
        worldBooks: this.worldBooks, selectedWBIds,
        keepLast: SUMMARY_KEEP_LAST
      });
      const raw = await this._callAI(prompt, true);
      let d;
      try {
        d = safeParseJSON(raw, '故事推进');
      } catch (e) {
        // 解析失败降级：把原始文本作为旁白显示
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
      this._maybeSummary(id, all).catch(e => console.warn(e));
      return { segments: segs, text, choices, isEnding: !!d.isEnding };
    }

    async regenerateLast(id) {
      const s = this.getSession(id); if (!s) throw new Error('会话不存在');
      const msgs = s.messages;
      if (msgs.length < 2 || msgs[msgs.length-1].role !== 'narrator' || msgs[msgs.length-2].role !== 'user')
        throw new Error('没有可重新生成的内容');
      const last = msgs[msgs.length-2];
      this.updateSession(id, { messages: msgs.slice(0, -2) });
      try { return await this.advanceStory(id, last.text, last.choiceId); }
      catch(e) { this.updateSession(id, { messages: msgs }); throw e; }
    }

    async archiveSession(id) {
      const s = this.getSession(id); if (!s) throw new Error('会话不存在');
      const prompt = buildVerdictPrompt(s.worldSetting, s.summaries, s.messages);
      let verdict = '';
      try { verdict = stripQuotes((await this._callAI(prompt, false)).trim()); }
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
      const text = (await this._callAI(prompt, false)).trim();
      this.updateSession(id, { summaries: [...s.summaries, { text, coveredUpTo: end, generatedAt: Date.now() }] });
    }

    // ===== 滚动位置保存/恢复 =====
    _saveScroll() {
      const body = this.pageEl && this.pageEl.querySelector('.fl-body');
      if (body) this._scrollTop = body.scrollTop;
    }
    _restoreScroll() {
      const body = this.pageEl && this.pageEl.querySelector('.fl-body');
      if (body) body.scrollTop = this._scrollTop;
    }

    // ===== 滚动到底部按钮 =====
    _setupScrollButton() {
      this._removeScrollListener();
      const body = this.pageEl && this.pageEl.querySelector('.fl-body');
      if (!body) return;
      // 创建按钮
      const btn = document.createElement('button');
      btn.className = 'fl-scroll-btn';
      btn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
      btn.onclick = () => { body.scrollTo({ top: body.scrollHeight, behavior: 'smooth' }); };
      this.pageEl.appendChild(btn);
      this._scrollBtn = btn;
      // 监听滚动
      this._onScroll = () => {
        const threshold = 100;
        const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < threshold;
        if (atBottom) {
          btn.classList.remove('visible');
        } else {
          btn.classList.add('visible');
        }
      };
      body.addEventListener('scroll', this._onScroll, { passive: true });
      this._onScroll(); // 初始状态
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
      root.appendChild(this._createRain());
      this.container.appendChild(root);
      this.root = root;
      this.pageEl = root;
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
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
            </button>
            <div class="fl-header-center">
              <div class="fl-title">浮生</div>
              <div class="fl-subtitle">一场醒来就忘的梦</div>
            </div>
            <button class="fl-icon-btn" id="fl-theme-toggle" title="主题">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>
            </button>
            <button class="fl-icon-btn" id="fl-new" title="开启浮生">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
            </button>
          </div>
        </div>
        <div class="fl-body">
      `;

      // 进行中
      html += `<div class="fl-group">
        <div class="fl-group-header">
          <svg class="fl-group-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
          <span class="fl-group-title">进行中</span>
        </div>`;
      if (activeSessions.length === 0) {
        html += `<div class="fl-empty">
          <svg class="fl-empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
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

      // 故梦
      html += `<div class="fl-group">
        <div class="fl-group-header">
          <svg class="fl-group-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8v13H3V8"/><path d="M1 3h22v5H1z"/><path d="M10 12h4"/></svg>
          <span class="fl-group-title">故梦</span>
        </div>`;
      if (archivedSessions.length === 0) {
        html += `<div style="text-align:center;padding:16px;color:rgba(100,116,139,0.45);font-size:11px;">尚无封存的故事</div>`;
      } else {
        archivedSessions.forEach(s => { html += this._renderSessionCard(s); });
      }
      html += `</div>`;
      html += '</div>';

      this.pageEl.innerHTML = html;

      this.pageEl.querySelectorAll('.fl-session-card').forEach(item => {
        item.onclick = (e) => {
          if (e.target.closest('.fl-card-delete')) return;
          this.sessionId = item.dataset.id;
          this.page = 'story';
          this._scrollTop = 0;
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
      if (newBtn) newBtn.onclick = () => { this.selChars = []; this.selWBIds = []; this.draftTheme = ''; this._scrollTop = 0; this.page = 'create'; this.render(); };
      const startEmpty = this.pageEl.querySelector('#fl-start-empty');
      if (startEmpty) startEmpty.onclick = () => { this.selChars = []; this.selWBIds = []; this.draftTheme = ''; this._scrollTop = 0; this.page = 'create'; this.render(); };
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
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6"/></svg>
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
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
            </button>
            <div class="fl-header-center"><div class="fl-title-sm">开启浮生</div></div>
          </div>
        </div>
        <div class="fl-body">
          <div style="margin-bottom:24px;">
            <div class="fl-section-label">选择角色</div>
      `;
      if (this.characters.length === 0) {
        html += '<div style="text-align:center;padding:20px;color:rgba(148,163,184,0.55);font-size:12px;">暂无角色，请先在 Roche 中创建角色</div>';
      } else {
        this.characters.forEach(c => {
          const name = c.handle || c.name || '未知';
          const active = this.selChars.includes(c.id) ? 'active' : '';
          const color = c.avatarColor || '#64748b';
          const avatar = c.avatar ? `<img src="${esc(c.avatar)}" alt="">` : `<span style="color:${color}">${name[0]}</span>`;
          html += `<button class="fl-char-item ${active}" data-id="${c.id}">
            <div class="fl-char-avatar" style="background:${color}25">${avatar}</div>
            <div class="fl-char-name">${esc(name)}</div>
            <div class="fl-char-check">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#0d1017" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
            </div>
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
        <div class="fl-wb-hint">选取后，浮生将在构建世界观和推进剧情时参考这些条目。不选则完全基于角色人设自由生成。</div>`;
      if (this.worldBooks.length === 0) {
        html += '<div style="text-align:center;padding:14px;color:rgba(100,116,139,0.5);font-size:11px;">暂无可用的世界书条目</div>';
      } else {
        Object.entries(wbByCat).forEach(([catName, items]) => {
          html += `<div class="fl-wb-group">
            <div class="fl-wb-cat-title">${esc(catName)}</div>`;
          items.forEach(w => {
            const name = w.title || w.name || '未命名';
            const active = this.selWBIds.includes(w.id) ? 'active' : '';
            html += `<button class="fl-wb-item ${active}" data-id="${w.id}">
              <div class="fl-wb-check">
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#0d1017" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
              </div>
              <span class="fl-wb-name">${esc(name)}</span>
            </button>`;
          });
          html += `</div>`;
        });
      }

      html += `</div><div style="margin-bottom:4px;">
        <div class="fl-section-label">题材方向 <span style="color:rgba(100,116,139,0.55);font-size:10px;font-weight:normal;">（可选，留空则 AI 随机生成）</span></div>
        <input type="text" id="fl-theme" placeholder="例：末日公路片、民国悬疑、赛博朋克…" value="${esc(this.draftTheme)}" />
      </div></div>
      <div class="fl-footer">
        <button class="fl-btn fl-btn-primary fl-btn-block" id="fl-start-dream" ${this.selChars.length===0?'disabled':''}>开启这场梦</button>
      </div>`;

      this.pageEl.innerHTML = html;
      // 恢复滚动位置
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

      this.pageEl.querySelectorAll('.fl-wb-item').forEach(item => item.onclick = () => {
        this._saveScroll();
        this._saveDraftTheme();
        const id = item.dataset.id;
        if (this.selWBIds.includes(id)) this.selWBIds = this.selWBIds.filter(x=>x!==id);
        else this.selWBIds.push(id);
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
      this.draftTheme = '';
      this._scrollTop = 0;
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
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
            </button>
            <div class="fl-header-center">
              <div class="fl-title-sm">${esc(title)}</div>
              ${(s.worldSetting.keywords||[]).length>0 ? `<div class="fl-keywords">${s.worldSetting.keywords.map(k=>`<span class="fl-keyword">${esc(k)}</span>`).join('')}</div>` : ''}
            </div>
            <button class="fl-icon-btn" id="fl-delete" title="删除">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6"/></svg>
            </button>
            ${s.status==='active' ? `<button class="fl-archive-btn-sm" id="fl-archive-header">封存</button>` : ''}
          </div>
        </div>
        <div class="fl-body" style="padding:16px 22px 20px;">
      `;

      if (s.status === 'archived' && s.verdict) {
        html += `<div class="fl-verdict">
          <div class="fl-verdict-label">判 词</div>
          <div class="fl-verdict-text">${esc(s.verdict)}</div>
        </div>`;
      }

      // 故事内容：直接渲染叙事和对话，不显示世界观卡片
      const renderMessage = (msg) => {
        if (msg.role === 'user') {
          return `<div class="fl-msg-user"><div class="bubble">▸ ${esc(msg.text)}</div></div>`;
        }
        let out = '';
        if (msg.parseError) {
          out += `<div class="fl-parse-error">内容解析失败，原始输出：<pre>${esc(msg.text)}</pre></div>`;
        }
        if (msg.segments && msg.segments.length > 0) {
          msg.segments.forEach(seg => {
            if (seg.type === 'narration') {
              out += `<div class="fl-msg-narration">${esc(seg.text)}</div>`;
            } else {
              // 通过名字匹配角色
              let matchedChar = null;
              if (seg.character) {
                matchedChar = this.characters.find(c => (c.handle||c.name) === seg.character);
              }
              const charName = seg.character || '';
              out += `<div class="fl-msg-dialogue">
                ${this._getCharAvatar(matchedChar, charName)}
                <div class="fl-dialogue-name">${esc(charName)}</div>
                ${seg.action ? `<div class="fl-msg-action">${esc(seg.action)}</div>` : ''}
                <div class="fl-msg-text">「${esc(seg.text)}」</div>
              </div>`;
            }
          });
        } else if (msg.text) {
          out += `<div class="fl-msg-narration">${esc(msg.text)}</div>`;
        }
        return out;
      };

      s.messages.forEach(msg => { html += renderMessage(msg); });

      // 待确认的开场白
      if (s.pendingOpening && s.messages.length === 0) {
        const po = s.pendingOpening;
        if (po.parseError) {
          html += `<div class="fl-parse-error">世界观生成内容解析失败，原始输出：<pre>${esc(po.rawText || po.openingText)}</pre></div>`;
        }
        if (po.openingSegments && po.openingSegments.length > 0) {
          po.openingSegments.forEach(seg => {
            if (seg.type === 'narration') {
              html += `<div class="fl-msg-narration">${esc(seg.text)}</div>`;
            } else {
              let matchedChar = null;
              if (seg.character) {
                matchedChar = this.characters.find(c => (c.handle||c.name) === seg.character);
              }
              html += `<div class="fl-msg-dialogue">
                ${this._getCharAvatar(matchedChar, seg.character || '')}
                <div class="fl-dialogue-name">${esc(seg.character || '')}</div>
                ${seg.action ? `<div class="fl-msg-action">${esc(seg.action)}</div>` : ''}
                <div class="fl-msg-text">「${esc(seg.text)}」</div>
              </div>`;
            }
          });
        }
      }

      // 底部操作区（在内容流中，不固定）
      if (s.status === 'active') {
        if (s.pendingOpening && s.messages.length === 0 && !this.loading) {
          html += `<div style="display:flex;gap:10px;margin-top:20px;">
            <button class="fl-btn fl-btn-ghost" id="fl-regen-world">重新生成</button>
            <button class="fl-btn fl-btn-primary" style="flex:1;" id="fl-enter-dream">进入浮生</button>
          </div>`;
        } else if (s.messages.length === 0) {
          if (this.loading) {
            html += '<div class="fl-loading"><span class="fl-spinner"></span>正在造梦…</div>';
          } else {
            html += '<div style="text-align:center;margin-top:16px;"><div style="color:rgba(239,68,68,0.6);font-size:12px;margin-bottom:10px;">世界观生成失败，请重试</div><button class="fl-btn fl-btn-primary" id="fl-retry-world">重新生成世界观</button></div>';
          }
        } else {
          const last = s.messages[s.messages.length - 1];
          if (last && last.role === 'narrator' && last.choices && last.choices.length > 0 && !this.loading) {
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
            // 自由输入
            html += `<div class="fl-free-input">
              <input type="text" id="fl-free" placeholder="或者，写下你想做的事…" />
              <button class="fl-btn fl-btn-primary" id="fl-free-send">发送</button>
            </div>`;
            // 重新生成
            html += `<div class="fl-regen-row">
              <button class="fl-btn fl-btn-ghost" style="font-size:11px;padding:5px 12px;" id="fl-regen">重新生成</button>
            </div>`;
          } else if (this.loading) {
            html += '<div class="fl-loading"><span class="fl-spinner"></span>落笔中…</div>';
          }
        }
      }

      html += '</div>';
      this.pageEl.innerHTML = html;

      // 恢复滚动位置（不自动滚动到底部）
      requestAnimationFrame(() => this._restoreScroll());

      // 设置滚动到底部按钮
      this._setupScrollButton();

      // 事件绑定
      this.pageEl.querySelector('#fl-story-back').onclick = () => {
        this.sessionId = null; this._scrollTop = 0; this.page = 'list'; this.render();
      };
      this.pageEl.querySelector('#fl-delete').onclick = async () => {
        const ok = await this.roche.ui.confirm({ title:'确认删除', message:'确定删除这场梦吗？此操作不可撤销。' });
        if (ok) { this.deleteSession(this.sessionId); this.sessionId=null; this._scrollTop=0; this.page='list'; this.render(); }
      };
      const archiveHeader = this.pageEl.querySelector('#fl-archive-header');
      if (archiveHeader) archiveHeader.onclick = () => this._archiveFlow();

      // 开场白操作
      const enterBtn = this.pageEl.querySelector('#fl-enter-dream');
      if (enterBtn) enterBtn.onclick = () => { this.confirmOpening(this.sessionId); this._scrollTop = 0; this.render(); };
      const regenWorld = this.pageEl.querySelector('#fl-regen-world');
      if (regenWorld) regenWorld.onclick = () => this._genWorldFlow();
      const retryWorld = this.pageEl.querySelector('#fl-retry-world');
      if (retryWorld) retryWorld.onclick = () => this._genWorldFlow();

      // 选项点击
      this.pageEl.querySelectorAll('.fl-choice-btn').forEach(btn => {
        btn.onclick = () => {
          const id = btn.dataset.choiceId;
          const text = btn.querySelector('.fl-choice-text').textContent;
          this._advanceFlow(text, id);
        };
      });

      // 自由输入
      const freeInput = this.pageEl.querySelector('#fl-free');
      const freeSend = this.pageEl.querySelector('#fl-free-send');
      if (freeSend) freeSend.onclick = () => { const t = freeInput.value.trim(); if (t) this._advanceFlow(t); };
      if (freeInput) freeInput.onkeydown = e => { if (e.key === 'Enter') freeSend.click(); };

      // 重新生成
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

    async _advanceFlow(text, choiceId) {
      if (this.loading) return;
      // 保存当前滚动位置，loading后恢复（不自动到底部）
      this._saveScroll();
      this.loading = true; this.render();
      try { await this.advanceStory(this.sessionId, text, choiceId); }
      catch(e) { this.roche.ui.toast('故事推进失败：'+e.message); }
      finally {
        this.loading = false;
        this.render();
        // 新内容生成后，滚动到新内容位置（接近底部但不强制到底）
        requestAnimationFrame(() => {
          const body = this.pageEl && this.pageEl.querySelector('.fl-body');
          if (body) body.scrollTop = body.scrollHeight;
        });
      }
    }

    async _regenFlow() {
      if (this.loading) return;
      this._saveScroll();
      this.loading = true; this.render();
      try { await this.regenerateLast(this.sessionId); }
      catch(e) { this.roche.ui.toast('重新生成失败：'+e.message); }
      finally {
        this.loading = false;
        this.render();
        requestAnimationFrame(() => {
          const body = this.pageEl && this.pageEl.querySelector('.fl-body');
          if (body) body.scrollTop = body.scrollHeight;
        });
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
    version: '3.0.0',
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
