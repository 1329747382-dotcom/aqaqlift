/**
 * 浮生 (FloatingLife) - Roche 全信任 JS 插件
 * 一场醒来就忘的梦
 * 仅读取人设、角色和世界书，构成一次封闭的平行宇宙角色扮演，
 * 其内生成的信息内容不与外部其他功能共享。
 */

(function () {
  'use strict';

  // ========== 配置 ==========
  const STORAGE_KEY = 'floating_life_sessions';
  const SETTINGS_KEY = 'floating_life_settings';
  const SUMMARY_THRESHOLD = 16;
  const SUMMARY_KEEP_LAST = 8;

  // ========== 工具函数 ==========

  function safeParseJSON(text, context) {
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error(`浮生：${context}返回的内容无法解析为 JSON`);
    }
  }

  function getPerspectiveText(perspective, userName, userGender) {
    const pronoun = (userGender === '男' || userGender === '男性') ? '他' : '她';
    switch (perspective) {
      case 'second-person':
        return '使用第二人称叙事，称呼用户为「你」。';
      case 'first-person':
        return '使用第一人称叙事，称呼角色自己为「我」，让读者代入该角色。';
      case 'third-limited':
      default:
        return `使用第三人称有限视角叙事，称呼用户角色为「${userName}」或「${pronoun}」。`;
    }
  }

  function formatGlobalWorldBooks(worldBooks) {
    const global = (worldBooks || []).filter(w => w.isGlobalActive === true || w.scope === 'global');
    if (global.length === 0) return '';
    return '【全局世界书】\n' + global.map(w =>
      `[${w.title || w.name || '未命名'}]（类型：${w.categoryId || w.category || '未知'}）\n${w.content || w.text || ''}`
    ).join('\n');
  }

  function formatCharactersInfo(characters, worldBooks) {
    return (characters || []).map(char => {
      const lines = [`名字：${char.name || char.handle || '未知'}`];
      if (char.gender) lines.push(`性别：${char.gender}`);
      if (char.bio) lines.push(`简介：${char.bio}`);

      const personaText = char.persona || char.background || char.description || '';
      const mountedIds = new Set(char.mountedWorldBookIds || char.worldBookIds || []);

      // lore 类世界书
      const lore = (worldBooks || []).filter(w =>
        (w.categoryId === 'lore' || w.category === 'lore') &&
        mountedIds.has(w.id) && !(w.isGlobalActive === true)
      );
      if (lore.length > 0) {
        lines.push('补充背景知识：');
        lore.forEach(w => lines.push(`- ${w.title || w.name}：${w.content || w.text}`));
      }

      if (personaText) lines.push(`人设：${personaText}`);

      // patch 类世界书
      const patches = (worldBooks || []).filter(w =>
        (w.categoryId === 'patch' || w.category === 'patch') &&
        mountedIds.has(w.id) && !(w.isGlobalActive === true)
      );
      if (patches.length > 0) {
        lines.push('灵魂补丁：');
        patches.forEach(w => lines.push(`- ${w.title || w.name}：${w.content || w.text}`));
      }

      return lines.join('\n');
    }).join('\n---\n');
  }

  function buildContext(worldSetting, messages, summaries, characters, user, keepLast, worldBooks) {
    const parts = [];
    const globalWB = formatGlobalWorldBooks(worldBooks);
    if (globalWB) parts.push(globalWB);

    parts.push(`【世界观】
场景：${worldSetting.scene || ''}
冲突种子：${worldSetting.conflictSeed || ''}
氛围关键词：${(worldSetting.keywords || []).join('、')}
暗线：${worldSetting.hiddenArc || ''}`);

    const roleLines = Object.entries(worldSetting.characterRoles || {}).map(([id, role]) => {
      const char = (characters || []).find(c => c.id === id);
      const name = (char && (char.name || char.handle)) || id;
      const originTrait = (char && (char.persona || char.background)) ? `（原始性格特征：${char.persona || char.background}）` : '';
      return `${name}：${role}${originTrait}`;
    });
    if (user) {
      const userOrigin = (user.persona || user.background) ? `（原始性格特征：${user.persona || user.background}）` : '';
      roleLines.unshift(`${user.name || user.handle || '用户'}（用户）：${worldSetting.userRole || ''}${userOrigin}`);
    } else {
      roleLines.unshift(`用户：${worldSetting.userRole || ''}`);
    }
    parts.push(`【角色（平行身份）】\n${roleLines.join('\n')}`);

    if (summaries && summaries.length > 0) {
      parts.push(`【之前的故事摘要】\n${summaries.map(s => s.text).join('\n')}`);
    }

    const recent = (messages || []).slice(-keepLast);
    if (recent.length > 0) {
      parts.push(`【最近对话】\n${recent.map(m =>
        m.role === 'narrator' ? `[叙述者] ${m.text}` : `[用户选择] ${m.text}`
      ).join('\n')}`);
    }

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
        if (t.startsWith(open) && t.endsWith(close) && t.length > 1) {
          t = t.slice(1, -1).trim();
          changed = true;
          break;
        }
      }
    }
    return t;
  }

  function normalizeSegments(segments) {
    if (!Array.isArray(segments)) return [];
    return segments.map(seg => {
      if (seg.type === 'dialogue') {
        return {
          type: 'dialogue',
          text: stripQuotes(String(seg.text || '')),
          character: String(seg.character || ''),
          action: seg.action ? String(seg.action) : undefined
        };
      }
      return { type: 'narration', text: String(seg.text || '') };
    }).filter(seg => seg.text);
  }

  function normalizeChoices(choices) {
    if (!Array.isArray(choices)) return [];
    return choices.map((c, i) => ({
      id: c.id ?? (i + 1),
      text: String(c.text || ''),
      tag: String(c.tag || '')
    }));
  }

  function generateId(prefix) {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
  }

  // ========== Prompt 构建 ==========

  function buildWorldPrompt(params) {
    const { user, characters, perspective, userTheme, worldBooks } = params;
    const userName = user.name || user.handle || '旅人';
    const charactersInfo = formatCharactersInfo(characters, worldBooks);
    const perspectiveText = getPerspectiveText(perspective, userName, user.gender);
    const globalWB = formatGlobalWorldBooks(worldBooks);
    const characterIds = (characters || []).map(c => c.id).join(', ');

    const globalSection = globalWB
      ? `## 全局世界书\n以下是全局规则和设定，在构建世界观时必须遵守：\n${globalWB}\n\n`
      : '';

    const themeSection = userTheme
      ? `## 用户指定题材方向（最高优先级）\n用户明确要求的题材是：「${userTheme}」\n你必须严格按照这个方向构建世界观。不要偏离用户指定的题材去生成悬疑、惊悚、奇幻等用户没有要求的类型。\n\n`
      : `## 题材方向\n由你自由发挥，请大胆创造有趣且出人意料的设定。\n\n`;

    return `你是「浮生」系统的世界架构师。

任务：基于下列角色的性格和人设，构建一个平行宇宙世界观，并撰写开场白。

## 角色信息

### 用户
名字：${userName}
性别：${user.gender || '未知'}
简介：${user.bio || ''}
背景：${user.persona || user.background || ''}

### AI 角色
${charactersInfo}

${globalSection}${themeSection}## 叙事视角
${perspectiveText}

## 输出要求
返回严格 JSON，结构如下：
{
  "title": "世界短标题（2-6字，用·分隔，如「法租界·雨夜」「星际矿场」「末日花园」）",
  "scene": "时代与场景描述（2-3 句话，要有画面感）",
  "characterRoles": {
    "<角色ID>": "该角色在平行世界的身份与处境（1-2 句）"
  },
  "userRole": "用户在平行世界的身份与处境（1-2 句）",
  "conflictSeed": "核心冲突种子（1 句话，引出故事张力）",
  "keywords": ["氛围关键词1", "关键词2", "关键词3"],
  "hiddenArc": "1-2 句话描述故事暗线，这条暗线将在背景中影响故事走向但不会直接告知用户",
  "openingSegments": [
    { "type": "narration", "text": "场景描写…" },
    { "type": "dialogue", "character": "角色名", "text": "角色说的话", "action": "可选的动作描写，必须是完整的句子，有句号。" },
    { "type": "narration", "text": "叙事继续…" }
  ],
  "choices": [
    { "id": 1, "text": "选项1（≤15字）", "tag": "标签" },
    { "id": 2, "text": "选项2（≤15字）", "tag": "标签" },
    { "id": 3, "text": "选项3（≤15字）", "tag": "标签" }
  ]
}

## 核心原则
- 角色的平行身份必须保留其原始人设的核心性格特征，但可以放到完全不同的背景中
- 如果用户指定了题材方向，必须严格遵守，这是最高优先级
- 如果用户没有指定题材，则自由发挥，大胆创造有趣且出人意料的设定
- 开场白用文学化的叙事语言，不要写成说明文
- 开场白中应该自然地让至少一个角色开口说话，让场景活起来
- openingSegments 产生 4-10 个 segments，总字数 500-800 字
- 三个选项应指向不同的故事方向，各有特色
- 暗线要巧妙，与表面冲突形成反差或互补
- characterRoles 的 key 必须用角色 ID：${characterIds}`;
  }

  function buildStoryPrompt(params) {
    const { session, user, characters, userInput, worldBooks, keepLast } = params;
    const userName = user.name || user.handle || '旅人';
    const context = buildContext(
      session.worldSetting, session.messages, session.summaries,
      characters, user, keepLast, worldBooks
    );
    const perspectiveText = getPerspectiveText(session.perspective, userName, user.gender);
    const userActionCount = (session.messages || []).filter(m => m.role === 'user').length;

    return `你是「浮生」故事的叙述者，负责推进平行宇宙剧情。
你同时扮演所有参与角色，在叙事中穿插角色的对话和动作。根据情境判断谁该说话、谁该行动，不是每个角色每轮都要出场。

## 上下文
${context}

## 叙事视角
${perspectiveText}

## 用户的行动
${userInput}

## 当前进度
这是用户的第 ${userActionCount} 次行动。

## 输出要求
返回严格 JSON：
{
  "segments": [
    { "type": "narration", "text": "旁白叙事…" },
    { "type": "dialogue", "character": "角色名", "text": "角色说的话", "action": "可选的动作描写，必须是完整的句子，有句号。" },
    { "type": "narration", "text": "旁白继续…" }
  ],
  "choices": [
    { "id": 1, "text": "选项1（≤15字）", "tag": "标签" },
    { "id": 2, "text": "选项2（≤15字）", "tag": "标签" },
    { "id": 3, "text": "选项3（≤15字）", "tag": "标签" }
  ],
  "isEnding": false
}

segments 说明：
- "narration"：旁白叙事，描绘场景、氛围、内心活动
- "dialogue"：角色对话，character 必须是角色的名字，text 是角色说的话，action 可选
- 每次推进产生 4-10 个 segments，自然交织旁白和对话
- 全部 segments 加起来 500-800 字

## isEnding 说明
- isEnding 表示"这个故事是否已经走到一个自然的结局点"
- 当故事中的核心冲突已基本解决、角色的命运走向明朗、叙事弧线接近收束时，设为 true
- 一般来说，前 8 轮不要设为 true；第 8 轮之后，如果叙事节奏合适，可以开始收束
- 当 isEnding 为 true 时，这一轮的叙事应有"落幕感"
- 即使 isEnding 为 true，仍然提供 3 个选项，让用户可以选择继续故事

## 角色扮演规则
- 你负责扮演所有 AI 角色，让他们开口说话、做出动作
- 每个角色的台词和行为必须贴合其平行身份的性格
- 根据情境判断谁该参与这个场景，不用每轮所有角色都出场
- 对话要有性格化的口吻，不要写成千篇一律的旁白体

## 叙事优先级（从高到低）
1. **氛围感** — 场景描写要有画面、气味、声音，让读者沉浸
2. **选项有趣** — 三个选项必须指向截然不同的故事方向，带有性格色彩或道德抉择
3. **角色像那个角色** — AI 角色的对话和行为必须贴合其平行身份的性格
4. **叙事节奏** — 不要总是紧张对峙，松弛与高潮交替，偶尔给日常、幽默、温情留空间
5. **逻辑自洽** — 但不要为了自洽牺牲上面四点

## 关键规则
- 每次推进只写一个场景片段，不要试图把故事推进太远
- 暗线应该以微妙的方式影响故事发展，但不要在叙事中直接点破
- 不要重复用户的选择内容，直接展开该选择引发的后续
- 如果用户输入了自由文本而非选项，灵活接纳并合理融入故事`;
  }

  function buildSummaryPrompt(messages, existingSummaries) {
    const existingSection = (existingSummaries || []).length > 0
      ? `已有摘要：\n${existingSummaries.map(s => s.text).join('\n')}\n\n`
      : '';
    const messagesText = (messages || []).map(m =>
      m.role === 'narrator' ? `[叙述者] ${m.text}` : `[用户] ${m.text}`
    ).join('\n');

    return `你是故事摘要助手。请将以下故事片段压缩为简洁的叙事摘要。

${existingSection}需要摘要的新内容：
${messagesText}

要求：
- 保留关键情节转折、角色互动、重要决策
- 2-4 句话，100 字以内
- 不要丢失任何会影响后续剧情理解的细节
- 只输出摘要文本，不要任何额外格式`;
  }

  function buildVerdictPrompt(worldSetting, summaries, messages) {
    const storyText = (summaries || []).length > 0
      ? summaries.map(s => s.text).join('\n')
      : (messages || []).slice(-10).map(m =>
          m.role === 'narrator' ? `[叙述者] ${m.text}` : `[用户] ${m.text}`
        ).join('\n');
    const keywords = (worldSetting.keywords || []).join('、');

    return `以下是一段平行宇宙故事的完整记录。

## 世界观设定
场景：${worldSetting.scene || ''}
冲突：${worldSetting.conflictSeed || ''}
关键词：${keywords}

## 故事经过
${storyText}

请为这段故事写一段"判词"——用几句话总结这段故事的核心：
谁做了什么关键选择，走向了什么结局，留下了什么遗憾或圆满。

重要：基于**实际发生的故事内容**生成判词，不要基于预设暗线。用户实际走过的路才是这段浮生的真正故事。

风格要求：
- 与世界观的氛围匹配（古风设定用古风语言，现代设定用现代语言，赛博朋克用冷硬风格……）
- 简短，**严格不超过 50 字**
- 有诗意，像一枚印章盖在故事的最后一页
- 只输出判词文本，不要引号、不要额外格式

判词示例（仅供风格参考，不要照搬）：
- 民国风："法租界的雨停了三次，你们错过了两次，赶上了最后一次。"
- 赛博朋克："数据洪流里捞出一段未加密的记忆。已归档。访问权限：仅限当事人。"
- 奇幻："那条龙最终没有被杀死，它只是决定不再飞了。"
- 校园日常："六月的蝉还在叫，但留下来的人已经听懂了它在说什么。"`;
  }

  // ========== 主插件类 ==========

  class FloatingLifeApp {
    constructor(container, roche) {
      this.container = container;
      this.roche = roche;
      this.sessions = [];
      this.user = null;
      this.characters = [];
      this.worldBooks = [];
      this.currentPage = 'list';
      this.currentSessionId = null;
      this.selectedCharIds = [];
      this.selectedPerspective = 'third-limited';
      this.currentTab = 'active';
      this.loading = false;
      this.styleEl = null;
      this._timers = [];
    }

    async init() {
      this._injectStyles();
      await this._loadData();
      this.render();
    }

    async _loadData() {
      try {
        this.user = await this.roche.persona.getActiveUserPersona();
      } catch (e) { console.warn('获取用户人设失败', e); }
      try {
        this.characters = await this.roche.character.list();
      } catch (e) { console.warn('获取角色列表失败', e); this.characters = []; }
      try {
        const cats = await this.roche.worldbook.list();
        // 尝试获取所有世界书词条
        this.worldBooks = [];
        if (Array.isArray(cats)) {
          for (const cat of cats) {
            try {
              const entries = await this.roche.worldbook.getEntries({
                categoryId: cat.id || cat.categoryId,
                scope: 'global'
              });
              if (Array.isArray(entries)) {
                this.worldBooks.push(...entries.map(e => ({ ...e, categoryId: e.categoryId || cat.id })));
              }
            } catch (e) { /* 忽略单个分类失败 */ }
          }
        }
      } catch (e) { console.warn('获取世界书失败', e); this.worldBooks = []; }

      try {
        this.sessions = (await this.roche.storage.get(STORAGE_KEY)) || [];
      } catch (e) { console.warn('加载会话失败', e); this.sessions = []; }
    }

    async _saveSessions() {
      try {
        await this.roche.storage.set(STORAGE_KEY, this.sessions);
      } catch (e) { console.warn('保存会话失败', e); }
    }

    _injectStyles() {
      this.styleEl = document.createElement('style');
      this.styleEl.textContent = `
        .roche-plugin-floating-life { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; color: #e2e8f0; min-height: 100%; box-sizing: border-box; }
        .roche-plugin-floating-life * { box-sizing: border-box; }
        .roche-plugin-floating-life .fl-header { text-align: center; padding: 32px 0 24px; }
        .roche-plugin-floating-life .fl-title { font-size: 28px; font-weight: 300; letter-spacing: 8px; color: rgba(147,197,253,0.6); font-family: "Songti SC","SimSun",serif; }
        .roche-plugin-floating-life .fl-subtitle { font-size: 11px; color: rgba(148,163,184,0.5); margin-top: 6px; letter-spacing: 4px; }
        .roche-plugin-floating-life .fl-card { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); border-radius: 16px; padding: 16px; margin-bottom: 12px; }
        .roche-plugin-floating-life .fl-card-title { font-size: 12px; color: rgba(148,163,184,0.6); margin-bottom: 10px; letter-spacing: 2px; }
        .roche-plugin-floating-life .fl-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 10px 18px; border: none; border-radius: 12px; font-size: 13px; cursor: pointer; transition: all 0.2s; font-weight: 500; }
        .roche-plugin-floating-life .fl-btn-primary { background: rgba(147,197,253,0.15); color: #93c5fd; border: 1px solid rgba(147,197,253,0.2); }
        .roche-plugin-floating-life .fl-btn-primary:hover { background: rgba(147,197,253,0.25); }
        .roche-plugin-floating-life .fl-btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }
        .roche-plugin-floating-life .fl-btn-ghost { background: transparent; color: rgba(148,163,184,0.7); border: 1px solid rgba(255,255,255,0.08); }
        .roche-plugin-floating-life .fl-btn-ghost:hover { background: rgba(255,255,255,0.05); color: #e2e8f0; }
        .roche-plugin-floating-life .fl-btn-danger { background: rgba(239,68,68,0.1); color: #fca5a5; border: 1px solid rgba(239,68,68,0.2); }
        .roche-plugin-floating-life .fl-btn-block { width: 100%; }
        .roche-plugin-floating-life .fl-btn-sm { padding: 7px 12px; font-size: 12px; }
        .roche-plugin-floating-life .fl-session-item { padding: 14px; background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.06); border-radius: 14px; margin-bottom: 8px; cursor: pointer; transition: all 0.2s; }
        .roche-plugin-floating-life .fl-session-item:hover { background: rgba(255,255,255,0.05); }
        .roche-plugin-floating-life .fl-session-title { font-size: 14px; color: #e2e8f0; font-family: "Songti SC",serif; }
        .roche-plugin-floating-life .fl-session-meta { font-size: 10px; color: rgba(148,163,184,0.4); margin-top: 4px; }
        .roche-plugin-floating-life .fl-status { display: inline-block; padding: 1px 6px; border-radius: 4px; font-size: 9px; margin-left: 6px; }
        .roche-plugin-floating-life .fl-status-active { background: rgba(52,211,153,0.1); color: #6ee7b7; }
        .roche-plugin-floating-life .fl-status-archived { background: rgba(148,163,184,0.1); color: #94a3b8; }
        .roche-plugin-floating-life .fl-nav { display: flex; gap: 6px; margin-bottom: 16px; }
        .roche-plugin-floating-life .fl-nav-btn { flex: 1; padding: 8px; text-align: center; background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.06); border-radius: 10px; cursor: pointer; font-size: 12px; color: rgba(148,163,184,0.6); transition: all 0.2s; }
        .roche-plugin-floating-life .fl-nav-btn.active { background: rgba(147,197,253,0.1); color: #93c5fd; border-color: rgba(147,197,253,0.3); }
        .roche-plugin-floating-life .fl-char-item { display: flex; align-items: center; gap: 10px; padding: 10px; background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.06); border-radius: 12px; cursor: pointer; transition: all 0.2s; margin-bottom: 6px; }
        .roche-plugin-floating-life .fl-char-item:hover { background: rgba(255,255,255,0.05); }
        .roche-plugin-floating-life .fl-char-item.selected { background: rgba(147,197,253,0.1); border-color: rgba(147,197,253,0.3); }
        .roche-plugin-floating-life .fl-char-avatar { width: 36px; height: 36px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 600; flex-shrink: 0; overflow: hidden; }
        .roche-plugin-floating-life .fl-char-avatar img { width: 100%; height: 100%; object-fit: cover; }
        .roche-plugin-floating-life .fl-char-name { font-size: 13px; color: #e2e8f0; }
        .roche-plugin-floating-life .fl-char-desc { font-size: 11px; color: rgba(148,163,184,0.5); margin-top: 2px; }
        .roche-plugin-floating-life .fl-perspective-options { display: flex; gap: 6px; margin-bottom: 10px; }
        .roche-plugin-floating-life .fl-perspective-option { flex: 1; padding: 8px; text-align: center; background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.06); border-radius: 10px; cursor: pointer; transition: all 0.2s; }
        .roche-plugin-floating-life .fl-perspective-option.active { background: rgba(147,197,253,0.1); border-color: rgba(147,197,253,0.3); }
        .roche-plugin-floating-life .fl-perspective-label { font-size: 12px; color: #e2e8f0; }
        .roche-plugin-floating-life .fl-perspective-desc { font-size: 9px; color: rgba(148,163,184,0.4); margin-top: 3px; }
        .roche-plugin-floating-life input, .roche-plugin-floating-life textarea, .roche-plugin-floating-life select { width: 100%; padding: 8px 10px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; color: #e2e8f0; font-size: 13px; outline: none; transition: border-color 0.2s; margin-bottom: 10px; }
        .roche-plugin-floating-life input:focus, .roche-plugin-floating-life textarea:focus { border-color: rgba(147,197,253,0.4); }
        .roche-plugin-floating-life label { display: block; font-size: 11px; color: rgba(148,163,184,0.6); margin-bottom: 4px; }
        .roche-plugin-floating-life .fl-story-header { display: flex; align-items: center; gap: 10px; padding: 12px 0; border-bottom: 1px solid rgba(255,255,255,0.06); margin-bottom: 16px; }
        .roche-plugin-floating-life .fl-story-title { flex: 1; font-size: 16px; color: rgba(147,197,253,0.6); font-family: "Songti SC",serif; }
        .roche-plugin-floating-life .fl-world-scene { font-size: 13px; line-height: 1.8; color: rgba(226,232,240,0.7); font-family: "Songti SC",serif; text-indent: 2em; text-align: justify; padding: 10px 14px; background: rgba(255,255,255,0.02); border-radius: 10px; margin-bottom: 16px; }
        .roche-plugin-floating-life .fl-world-label { font-size: 10px; color: rgba(148,163,184,0.4); letter-spacing: 2px; margin-bottom: 6px; text-align: center; }
        .roche-plugin-floating-life .fl-msg-narration { font-size: 14px; line-height: 2; color: rgba(226,232,240,0.85); font-family: "Songti SC",serif; text-indent: 2em; text-align: justify; margin-bottom: 16px; }
        .roche-plugin-floating-life .fl-msg-dialogue { margin: 10px 0; padding-left: 12px; border-left: 2px solid rgba(99,102,241,0.2); }
        .roche-plugin-floating-life .fl-msg-speaker { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
        .roche-plugin-floating-life .fl-msg-speaker-name { font-size: 11px; color: rgba(147,197,253,0.5); letter-spacing: 2px; }
        .roche-plugin-floating-life .fl-msg-action { font-size: 12px; color: rgba(129,140,248,0.4); font-style: italic; }
        .roche-plugin-floating-life .fl-msg-text { font-size: 14px; line-height: 1.9; color: rgba(226,232,240,0.9); font-family: "Songti SC",serif; }
        .roche-plugin-floating-life .fl-msg-user { display: flex; justify-content: flex-end; margin: 12px 0; }
        .roche-plugin-floating-life .fl-msg-user .bubble { max-width: 80%; padding: 8px 14px; background: rgba(59,130,246,0.08); border: 1px solid rgba(59,130,246,0.15); border-radius: 12px; font-size: 13px; color: rgba(147,197,253,0.7); font-family: "Songti SC",serif; }
        .roche-plugin-floating-life .fl-choices { margin-top: 20px; }
        .roche-plugin-floating-life .fl-choices-label { text-align: center; font-size: 10px; color: rgba(148,163,184,0.4); letter-spacing: 4px; margin-bottom: 12px; }
        .roche-plugin-floating-life .fl-choice-btn { display: block; width: 100%; padding: 12px 16px; margin-bottom: 8px; background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; color: rgba(226,232,240,0.7); font-size: 13px; cursor: pointer; transition: all 0.2s; text-align: left; font-family: "Songti SC",serif; }
        .roche-plugin-floating-life .fl-choice-btn:hover:not(:disabled) { background: rgba(147,197,253,0.08); border-color: rgba(147,197,253,0.25); transform: translateX(4px); color: #e2e8f0; }
        .roche-plugin-floating-life .fl-choice-btn:disabled { opacity: 0.3; cursor: not-allowed; }
        .roche-plugin-floating-life .fl-choice-tag { float: right; font-size: 9px; color: rgba(148,163,184,0.4); }
        .roche-plugin-floating-life .fl-free-input { display: flex; gap: 6px; margin-top: 12px; }
        .roche-plugin-floating-life .fl-free-input input { margin-bottom: 0; flex: 1; }
        .roche-plugin-floating-life .fl-ending-hint { text-align: center; margin: 24px 0 12px; padding: 16px; border-top: 1px solid rgba(255,255,255,0.06); }
        .roche-plugin-floating-life .fl-ending-hint p { font-size: 11px; color: rgba(147,197,253,0.4); letter-spacing: 4px; margin-bottom: 12px; }
        .roche-plugin-floating-life .fl-verdict { text-align: center; padding: 32px 16px; margin: 20px 0; border-top: 1px solid rgba(255,255,255,0.06); border-bottom: 1px solid rgba(255,255,255,0.06); }
        .roche-plugin-floating-life .fl-verdict-label { font-size: 10px; color: rgba(147,197,253,0.3); letter-spacing: 6px; margin-bottom: 12px; }
        .roche-plugin-floating-life .fl-verdict-text { font-size: 16px; line-height: 2; color: rgba(147,197,253,0.7); font-family: "Songti SC",serif; max-width: 300px; margin: 0 auto; }
        .roche-plugin-floating-life .fl-loading { text-align: center; padding: 32px; color: rgba(148,163,184,0.5); font-size: 13px; }
        .roche-plugin-floating-life .fl-spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid rgba(147,197,253,0.2); border-top-color: rgba(147,197,253,0.6); border-radius: 50%; animation: fl-spin 0.8s linear infinite; vertical-align: middle; margin-right: 6px; }
        @keyframes fl-spin { to { transform: rotate(360deg); } }
        .roche-plugin-floating-life .fl-error { padding: 10px 14px; background: rgba(239,68,68,0.08); border: 1px solid rgba(239,68,68,0.2); border-radius: 10px; color: #fca5a5; font-size: 12px; margin-bottom: 12px; }
        .roche-plugin-floating-life .fl-empty { text-align: center; padding: 48px 16px; color: rgba(148,163,184,0.4); }
        .roche-plugin-floating-life .fl-empty-icon { font-size: 40px; margin-bottom: 12px; opacity: 0.3; }
        .roche-plugin-floating-life .fl-keywords { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 4px; }
        .roche-plugin-floating-life .fl-keyword { padding: 1px 6px; background: rgba(255,255,255,0.04); border-radius: 4px; font-size: 9px; color: rgba(148,163,184,0.5); }
      `;
      document.head.appendChild(this.styleEl);
    }

    destroy() {
      if (this.styleEl && this.styleEl.parentNode) {
        this.styleEl.parentNode.removeChild(this.styleEl);
      }
      this._timers.forEach(t => clearTimeout(t));
      this._timers = [];
    }

    // ========== 会话管理 ==========

    getSession(id) {
      return this.sessions.find(s => s.id === id) || null;
    }

    createSession(options) {
      const session = {
        id: generateId('fl'),
        userId: this.user ? this.user.id : 'default',
        status: 'active',
        createdAt: Date.now(),
        archivedAt: null,
        worldSetting: { title: '', scene: '', characterRoles: {}, userRole: '', conflictSeed: '', keywords: [], hiddenArc: '' },
        participantIds: options.participantIds || [],
        perspective: options.perspective || 'third-limited',
        userTheme: options.userTheme || undefined,
        messages: [],
        summaries: [],
        verdict: null
      };
      this.sessions.unshift(session);
      this._saveSessions();
      return session;
    }

    updateSession(id, updates) {
      const idx = this.sessions.findIndex(s => s.id === id);
      if (idx === -1) return null;
      this.sessions[idx] = { ...this.sessions[idx], ...updates };
      this._saveSessions();
      return this.sessions[idx];
    }

    deleteSession(id) {
      this.sessions = this.sessions.filter(s => s.id !== id);
      this._saveSessions();
    }

    // ========== AI 调用 ==========

    async _callAI(prompt, expectJSON) {
      const messages = [
        { role: 'system', content: expectJSON ? 'You are a helpful assistant. Please output valid JSON.' : 'You are a helpful assistant.' },
        { role: 'user', content: prompt }
      ];
      const result = await this.roche.ai.chat({ messages, temperature: 0.7 });
      return result.text || result.content || '';
    }

    async generateWorld(sessionId) {
      const session = this.getSession(sessionId);
      if (!session) throw new Error('会话不存在');

      const participants = this.characters.filter(c => session.participantIds.includes(c.id));
      const prompt = buildWorldPrompt({
        user: this.user || { name: '旅人' },
        characters: participants,
        perspective: session.perspective,
        userTheme: session.userTheme,
        worldBooks: this.worldBooks
      });

      const raw = await this._callAI(prompt, true);
      const data = safeParseJSON(raw, '世界观生成');

      const worldSetting = {
        title: data.title || '',
        scene: data.scene || '',
        characterRoles: data.characterRoles || {},
        userRole: data.userRole || '',
        conflictSeed: data.conflictSeed || '',
        keywords: Array.isArray(data.keywords) ? data.keywords : [],
        hiddenArc: data.hiddenArc || ''
      };
      const openingSegments = normalizeSegments(data.openingSegments || []);
      const openingText = openingSegments.length > 0 ? segmentsToText(openingSegments) : String(data.openingText || '');
      const openingChoices = normalizeChoices(data.choices || []);

      this.updateSession(sessionId, {
        worldSetting,
        pendingOpening: { openingSegments, openingText, openingChoices }
      });

      return { worldSetting, openingSegments, openingText, openingChoices };
    }

    confirmOpening(sessionId) {
      const session = this.getSession(sessionId);
      if (!session || !session.pendingOpening) return null;
      const { openingSegments, openingText, openingChoices } = session.pendingOpening;
      const msg = {
        id: generateId('msg'),
        role: 'narrator',
        text: openingText,
        segments: openingSegments.length > 0 ? openingSegments : undefined,
        choices: openingChoices,
        timestamp: Date.now()
      };
      return this.updateSession(sessionId, {
        messages: [...session.messages, msg],
        pendingOpening: undefined
      });
    }

    async advanceStory(sessionId, userInput, choiceId) {
      const session = this.getSession(sessionId);
      if (!session) throw new Error('会话不存在');
      if (session.status !== 'active') throw new Error('该会话已封存');

      const participants = this.characters.filter(c => session.participantIds.includes(c.id));
      const userMsg = {
        id: generateId('msg'),
        role: 'user',
        text: userInput,
        choiceId: choiceId ?? undefined,
        timestamp: Date.now()
      };
      const messagesWithUser = [...session.messages, userMsg];

      const prompt = buildStoryPrompt({
        session: { ...session, messages: messagesWithUser },
        user: this.user || { name: '旅人' },
        characters: participants,
        userInput,
        worldBooks: this.worldBooks,
        keepLast: SUMMARY_KEEP_LAST
      });

      const raw = await this._callAI(prompt, true);
      const data = safeParseJSON(raw, '故事推进');

      const segments = normalizeSegments(data.segments || []);
      const text = segments.length > 0 ? segmentsToText(segments) : String(data.narratorText || '');
      const choices = normalizeChoices(data.choices || []);

      const narratorMsg = {
        id: generateId('msg'),
        role: 'narrator',
        text,
        segments: segments.length > 0 ? segments : undefined,
        choices,
        isEnding: !!data.isEnding,
        timestamp: Date.now()
      };

      const allMessages = [...messagesWithUser, narratorMsg];
      this.updateSession(sessionId, { messages: allMessages });

      // 异步生成摘要
      this._maybeGenerateSummary(sessionId, allMessages).catch(e => console.warn('摘要生成失败', e));

      return { segments, text, choices, isEnding: !!data.isEnding };
    }

    async regenerateLast(sessionId) {
      const session = this.getSession(sessionId);
      if (!session) throw new Error('会话不存在');
      const msgs = session.messages;
      if (msgs.length < 2 || msgs[msgs.length - 1].role !== 'narrator' || msgs[msgs.length - 2].role !== 'user') {
        throw new Error('没有可重新生成的内容');
      }
      const lastUserMsg = msgs[msgs.length - 2];
      this.updateSession(sessionId, { messages: msgs.slice(0, -2) });
      try {
        return await this.advanceStory(sessionId, lastUserMsg.text, lastUserMsg.choiceId);
      } catch (e) {
        this.updateSession(sessionId, { messages: msgs });
        throw e;
      }
    }

    async archiveSession(sessionId) {
      const session = this.getSession(sessionId);
      if (!session) throw new Error('会话不存在');

      const prompt = buildVerdictPrompt(session.worldSetting, session.summaries, session.messages);
      let verdict = '';
      try {
        const raw = await this._callAI(prompt, false);
        verdict = stripQuotes(raw.trim());
      } catch (e) {
        console.warn('判词生成失败', e);
        verdict = '大梦一场，醒来皆忘。';
      }

      return this.updateSession(sessionId, {
        status: 'archived',
        archivedAt: Date.now(),
        verdict
      });
    }

    async _maybeGenerateSummary(sessionId, messages) {
      const session = this.getSession(sessionId);
      if (!session) return;
      const coveredUpTo = session.summaries.length > 0 ? session.summaries[session.summaries.length - 1].coveredUpTo : 0;
      if (messages.length - coveredUpTo < SUMMARY_THRESHOLD) return;

      const end = messages.length - SUMMARY_KEEP_LAST;
      if (end <= coveredUpTo) return;
      const toSummarize = messages.slice(coveredUpTo, end);
      if (toSummarize.length === 0) return;

      const prompt = buildSummaryPrompt(toSummarize, session.summaries);
      const text = (await this._callAI(prompt, false)).trim();
      const summary = { text, coveredUpTo: end, generatedAt: Date.now() };
      this.updateSession(sessionId, { summaries: [...session.summaries, summary] });
    }

    // ========== 渲染 ==========

    render() {
      this.container.innerHTML = '';
      const root = document.createElement('div');
      root.className = 'roche-plugin-floating-life';
      this.container.appendChild(root);
      this.root = root;

      if (this.currentPage === 'list') this._renderList();
      else if (this.currentPage === 'create') this._renderCreate();
      else if (this.currentPage === 'story') this._renderStory();
    }

    _renderList() {
      const sessions = this.sessions.filter(s => s.status === this.currentTab);
      let html = `
        <div class="fl-header">
          <div class="fl-title">浮 生</div>
          <div class="fl-subtitle">一 场 醒 来 就 忘 的 梦</div>
        </div>
        <div class="fl-nav">
          <div class="fl-nav-btn ${this.currentTab === 'active' ? 'active' : ''}" data-tab="active">进行中</div>
          <div class="fl-nav-btn ${this.currentTab === 'archived' ? 'active' : ''}" data-tab="archived">已封存</div>
        </div>
      `;

      if (sessions.length === 0) {
        html += `<div class="fl-empty">
          <div class="fl-empty-icon">🌙</div>
          <p>${this.currentTab === 'active' ? '还没有正在做的梦' : '还没有封存的梦'}</p>
        </div>`;
      } else {
        html += sessions.map(s => {
          const title = s.worldSetting.title || (s.worldSetting.keywords || []).join('·') || '新的浮生';
          const chars = (s.participantIds || []).map(id => {
            const c = this.characters.find(x => x.id === id);
            return c ? (c.handle || c.name) : id;
          }).join('、');
          const date = new Date(s.createdAt).toLocaleDateString('zh-CN');
          return `<div class="fl-session-item" data-id="${s.id}">
            <div class="fl-session-title">${escapeHtml(title)}
              <span class="fl-status ${s.status === 'active' ? 'fl-status-active' : 'fl-status-archived'}">${s.status === 'active' ? '进行中' : '已封存'}</span>
            </div>
            <div class="fl-session-meta">与 ${escapeHtml(chars)} 的浮生 · ${date} · ${s.messages.length} 条记录</div>
          </div>`;
        }).join('');
      }

      html += `<button class="fl-btn fl-btn-primary fl-btn-block" style="margin-top:16px;" id="fl-new-session">+ 开启浮生</button>`;

      this.root.innerHTML = html;

      this.root.querySelectorAll('.fl-nav-btn').forEach(btn => {
        btn.onclick = () => { this.currentTab = btn.dataset.tab; this.render(); };
      });
      this.root.querySelectorAll('.fl-session-item').forEach(item => {
        item.onclick = () => { this.currentSessionId = item.dataset.id; this.currentPage = 'story'; this.render(); };
      });
      this.root.querySelector('#fl-new-session').onclick = () => {
        this.selectedCharIds = [];
        this.currentPage = 'create';
        this.render();
      };
    }

    _renderCreate() {
      let html = `
        <div class="fl-story-header">
          <button class="fl-btn fl-btn-ghost fl-btn-sm" id="fl-back-list">← 返回</button>
          <div class="fl-story-title">开启浮生</div>
        </div>
        <div class="fl-card">
          <div class="fl-card-title">选择角色（至少1个）</div>
      `;

      if (this.characters.length === 0) {
        html += '<p style="color:rgba(148,163,184,0.5);font-size:12px;text-align:center;padding:16px;">暂无角色，请先在 Roche 中创建角色</p>';
      } else {
        html += '<div id="fl-char-list">';
        this.characters.forEach(c => {
          const name = c.handle || c.name || '未知';
          const selected = this.selectedCharIds.includes(c.id) ? 'selected' : '';
          const avatarColor = c.avatarColor || '#64748b';
          const avatar = c.avatar
            ? `<img src="${escapeHtml(c.avatar)}" alt="">`
            : `<span style="color:${avatarColor}">${name[0]}</span>`;
          html += `<div class="fl-char-item ${selected}" data-id="${c.id}">
            <div class="fl-char-avatar" style="background:${avatarColor}25">${avatar}</div>
            <div style="flex:1;min-width:0;">
              <div class="fl-char-name">${escapeHtml(name)}</div>
              <div class="fl-char-desc">${escapeHtml(c.bio || c.persona || '').slice(0, 40)}</div>
            </div>
          </div>`;
        });
        html += '</div>';
      }

      html += `</div>
        <div class="fl-card">
          <div class="fl-card-title">叙事视角</div>
          <div class="fl-perspective-options">
            <div class="fl-perspective-option ${this.selectedPerspective === 'third-limited' ? 'active' : ''}" data-value="third-limited">
              <div class="fl-perspective-label">第三人称</div>
              <div class="fl-perspective-desc">「她推开了那扇门…」</div>
            </div>
            <div class="fl-perspective-option ${this.selectedPerspective === 'second-person' ? 'active' : ''}" data-value="second-person">
              <div class="fl-perspective-label">第二人称</div>
              <div class="fl-perspective-desc">「你推开了那扇门…」</div>
            </div>
            <div class="fl-perspective-option ${this.selectedPerspective === 'first-person' ? 'active' : ''}" data-value="first-person">
              <div class="fl-perspective-label">第一人称</div>
              <div class="fl-perspective-desc">「我推开了那扇门…」</div>
            </div>
          </div>
        </div>
        <div class="fl-card">
          <div class="fl-card-title">题材方向（可选，留空则自由发挥）</div>
          <input type="text" id="fl-theme" placeholder="如：民国谍战、星际拓荒、校园日常、赛博朋克…" />
        </div>
        <button class="fl-btn fl-btn-primary fl-btn-block" id="fl-start-dream">开启这场梦</button>
      `;

      this.root.innerHTML = html;

      this.root.querySelector('#fl-back-list').onclick = () => { this.currentPage = 'list'; this.render(); };
      this.root.querySelectorAll('.fl-char-item').forEach(item => {
        item.onclick = () => {
          const id = item.dataset.id;
          if (this.selectedCharIds.includes(id)) this.selectedCharIds = this.selectedCharIds.filter(x => x !== id);
          else this.selectedCharIds.push(id);
          item.classList.toggle('selected');
        };
      });
      this.root.querySelectorAll('.fl-perspective-option').forEach(opt => {
        opt.onclick = () => {
          this.root.querySelectorAll('.fl-perspective-option').forEach(o => o.classList.remove('active'));
          opt.classList.add('active');
          this.selectedPerspective = opt.dataset.value;
        };
      });
      this.root.querySelector('#fl-start-dream').onclick = () => this._startDream();
    }

    async _startDream() {
      if (this.selectedCharIds.length === 0) {
        this.roche.ui.toast('请至少选择一个角色');
        return;
      }
      const theme = this.root.querySelector('#fl-theme').value.trim();
      const session = this.createSession({
        participantIds: this.selectedCharIds,
        perspective: this.selectedPerspective,
        userTheme: theme || undefined
      });
      this.currentSessionId = session.id;
      this.currentPage = 'story';
      this.render();
      await this._generateWorldFlow();
    }

    _renderStory() {
      const session = this.getSession(this.currentSessionId);
      if (!session) { this.currentPage = 'list'; this.render(); return; }

      const title = session.worldSetting.title || (session.worldSetting.keywords || []).join('·') || '新的浮生';
      let html = `
        <div class="fl-story-header">
          <button class="fl-btn fl-btn-ghost fl-btn-sm" id="fl-story-back">← 返回</button>
          <div class="fl-story-title">${escapeHtml(title)}</div>
          <button class="fl-btn fl-btn-danger fl-btn-sm" id="fl-delete-session">删除</button>
        </div>
      `;

      // 判词
      if (session.status === 'archived' && session.verdict) {
        html += `<div class="fl-verdict">
          <div class="fl-verdict-label">判 词</div>
          <div class="fl-verdict-text">${escapeHtml(session.verdict)}</div>
        </div>`;
      }

      // 世界观
      if (session.worldSetting.scene) {
        html += `<div class="fl-world-label">时 代 与 场 景</div>
          <div class="fl-world-scene">${escapeHtml(session.worldSetting.scene)}</div>`;
        if ((session.worldSetting.keywords || []).length > 0) {
          html += `<div class="fl-keywords" style="justify-content:center;margin-bottom:16px;">
            ${session.worldSetting.keywords.map(k => `<span class="fl-keyword">${escapeHtml(k)}</span>`).join('')}
          </div>`;
        }
      }

      // 消息
      session.messages.forEach(msg => {
        if (msg.role === 'user') {
          html += `<div class="fl-msg-user"><div class="bubble">▸ ${escapeHtml(msg.text)}</div></div>`;
        } else {
          if (msg.segments && msg.segments.length > 0) {
            html += '<div style="margin-bottom:16px;">';
            msg.segments.forEach(seg => {
              if (seg.type === 'narration') {
                html += `<div class="fl-msg-narration">${escapeHtml(seg.text)}</div>`;
              } else {
                html += `<div class="fl-msg-dialogue">
                  <div class="fl-msg-speaker">
                    <span class="fl-msg-speaker-name">${escapeHtml(seg.character || '')}</span>
                    ${seg.action ? `<span class="fl-msg-action">${escapeHtml(seg.action)}</span>` : ''}
                  </div>
                  <div class="fl-msg-text">「${escapeHtml(seg.text)}」</div>
                </div>`;
              }
            });
            html += '</div>';
          } else if (msg.text) {
            html += `<div class="fl-msg-narration">${escapeHtml(msg.text)}</div>`;
          }
        }
      });

      // 待确认开场白
      if (session.pendingOpening && session.messages.length === 0) {
        const po = session.pendingOpening;
        html += '<div style="margin-bottom:16px;">';
        po.openingSegments.forEach(seg => {
          if (seg.type === 'narration') {
            html += `<div class="fl-msg-narration">${escapeHtml(seg.text)}</div>`;
          } else {
            html += `<div class="fl-msg-dialogue">
              <div class="fl-msg-speaker"><span class="fl-msg-speaker-name">${escapeHtml(seg.character || '')}</span></div>
              <div class="fl-msg-text">「${escapeHtml(seg.text)}」</div>
            </div>`;
          }
        });
        html += '</div>';
      }

      this.root.innerHTML = html;

      // 操作区
      const actions = document.createElement('div');
      this.root.appendChild(actions);

      if (session.status === 'archived') {
        // 已封存，无操作
      } else if (session.pendingOpening && session.messages.length === 0) {
        actions.innerHTML = `<div style="display:flex;gap:8px;margin-top:16px;">
          <button class="fl-btn fl-btn-ghost" id="fl-regen-world">重新生成</button>
          <button class="fl-btn fl-btn-primary" style="flex:1" id="fl-enter-dream">进入浮生</button>
        </div>`;
        actions.querySelector('#fl-enter-dream').onclick = () => { this.confirmOpening(this.currentSessionId); this.render(); };
        actions.querySelector('#fl-regen-world').onclick = () => this._generateWorldFlow();
      } else if (session.messages.length === 0) {
        actions.innerHTML = '<div class="fl-loading"><span class="fl-spinner"></span>正在造梦…</div>';
      } else {
        const lastMsg = session.messages[session.messages.length - 1];
        if (lastMsg && lastMsg.role === 'narrator' && lastMsg.choices && lastMsg.choices.length > 0 && !this.loading) {
          if (lastMsg.isEnding) {
            actions.innerHTML = `<div class="fl-ending-hint">
              <p>故 事 似 乎 走 到 了 尾 声</p>
              <button class="fl-btn fl-btn-primary" id="fl-archive">封存这段浮生</button>
              <p style="margin-top:10px;font-size:9px;color:rgba(148,163,184,0.3);">或者，继续书写</p>
            </div>`;
            actions.querySelector('#fl-archive').onclick = () => this._archiveFlow();
          } else {
            actions.innerHTML = '<div class="fl-choices"><div class="fl-choices-label">你 的 选 择</div></div>';
            const choicesDiv = actions.querySelector('.fl-choices');
            lastMsg.choices.forEach(c => {
              const btn = document.createElement('button');
              btn.className = 'fl-choice-btn';
              btn.innerHTML = `${escapeHtml(c.text)}<span class="fl-choice-tag">${escapeHtml(c.tag || '')}</span>`;
              btn.onclick = () => this._advanceFlow(c.text, c.id);
              choicesDiv.appendChild(btn);
            });
          }

          // 自由输入
          const freeDiv = document.createElement('div');
          freeDiv.className = 'fl-free-input';
          freeDiv.innerHTML = `<input type="text" id="fl-free-input" placeholder="或者，写下你想做的事…" />
            <button class="fl-btn fl-btn-primary fl-btn-sm" id="fl-free-submit">发送</button>`;
          actions.appendChild(freeDiv);
          const freeInput = freeDiv.querySelector('#fl-free-input');
          freeDiv.querySelector('#fl-free-submit').onclick = () => {
            const text = freeInput.value.trim();
            if (text) this._advanceFlow(text);
          };
          freeInput.onkeydown = e => { if (e.key === 'Enter') freeDiv.querySelector('#fl-free-submit').click(); };

          // 重新生成
          const regenDiv = document.createElement('div');
          regenDiv.style.cssText = 'display:flex;gap:6px;margin-top:10px;justify-content:flex-end;';
          regenDiv.innerHTML = '<button class="fl-btn fl-btn-ghost fl-btn-sm" id="fl-regen">重新生成</button>';
          actions.appendChild(regenDiv);
          regenDiv.querySelector('#fl-regen').onclick = () => this._regenerateFlow();
        } else if (this.loading) {
          actions.innerHTML = '<div class="fl-loading"><span class="fl-spinner"></span>落笔中…</div>';
        }
      }

      // 绑定头部按钮
      this.root.querySelector('#fl-story-back').onclick = () => {
        this.currentSessionId = null;
        this.currentPage = 'list';
        this.render();
      };
      this.root.querySelector('#fl-delete-session').onclick = async () => {
        const ok = await this.roche.ui.confirm({ title: '确认删除', message: '确定删除这场梦吗？此操作不可撤销。' });
        if (ok) {
          this.deleteSession(this.currentSessionId);
          this.currentSessionId = null;
          this.currentPage = 'list';
          this.render();
        }
      };

      // 滚动到底部
      setTimeout(() => this.container.scrollTop = this.container.scrollHeight, 50);
    }

    async _generateWorldFlow() {
      this.loading = true;
      this.render();
      try {
        await this.generateWorld(this.currentSessionId);
      } catch (e) {
        this.roche.ui.toast('世界观生成失败：' + e.message);
      } finally {
        this.loading = false;
        this.render();
      }
    }

    async _advanceFlow(text, choiceId) {
      this.loading = true;
      this.render();
      try {
        await this.advanceStory(this.currentSessionId, text, choiceId);
      } catch (e) {
        this.roche.ui.toast('故事推进失败：' + e.message);
      } finally {
        this.loading = false;
        this.render();
      }
    }

    async _regenerateFlow() {
      this.loading = true;
      this.render();
      try {
        await this.regenerateLast(this.currentSessionId);
      } catch (e) {
        this.roche.ui.toast('重新生成失败：' + e.message);
      } finally {
        this.loading = false;
        this.render();
      }
    }

    async _archiveFlow() {
      this.loading = true;
      this.render();
      try {
        await this.archiveSession(this.currentSessionId);
        this.roche.ui.toast('浮生已封存');
      } catch (e) {
        this.roche.ui.toast('封存失败：' + e.message);
      } finally {
        this.loading = false;
        this.render();
      }
    }
  }

  // ========== 注册插件 ==========

  window.RochePlugin.register({
    id: 'floating-life',
    name: '浮生',
    version: '1.0.0',
    apps: [
      {
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
          if (container._floatingLifeApp) {
            container._floatingLifeApp.destroy();
            container._floatingLifeApp = null;
          }
          container.replaceChildren();
        }
      }
    ]
  });

})();
