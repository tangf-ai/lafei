import type { Note, Task } from "../types";
import { newId } from "./util";

function isoDay(daysFromToday: number) {
  const date = new Date();
  date.setDate(date.getDate() + daysFromToday);
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 10);
}

export function seedData(): { notes: Note[]; tasks: Task[] } {
  const now = Date.now();
  const welcome: Note = {
    id: newId(),
    title: "欢迎来到 Lafei",
    tags: ["开始", "指南"],
    pinned: true,
    createdAt: now - 1000 * 60 * 60 * 24 * 2,
    updatedAt: now - 1000 * 60 * 22,
    content: `# 让知识落地，让行动有迹可循

Lafei 是一个**本地优先**的笔记与任务空间。你的文字先属于你，AI 只是顺手递来的一支笔。

## 从这里开始

- 在左侧点 **新建笔记**，直接开始写。支持 Markdown，也支持 \`[[双向链接]]\`
- 在「任务」里记下要做的事，或者让 AI 从笔记中帮你提取
- 点任意笔记右上角的 **AI**，试试总结、润色和提取待办

> 你的数据保存在这台设备本地。记得在「设置 → 数据」里定期导出备份。

## 一个简单的工作流

1. 灵感出现时，扔进 [[把知识变成行动]] 这样的主题笔记
2. 每周用 [[每周回顾 · 模板]] 收拢一次
3. 把笔记里冒出来的下一步，提取成任务

祝你写得顺手。`,
  };

  const knowledge: Note = {
    id: newId(),
    title: "把知识变成行动",
    tags: ["方法", "知识管理"],
    pinned: false,
    createdAt: now - 1000 * 60 * 60 * 24,
    updatedAt: now - 1000 * 60 * 60 * 5,
    content: `# 把知识变成行动

收藏不是理解，笔记也不是终点。真正有用的知识，会在某个具体的下一步里出现。

## 三层结构

- **捕捉**：先记下来，不评判。碎片放进当日笔记，完整的想法单独成篇
- **连接**：给笔记加标签，用 \`[[链接]]\` 把它接到已有的知识上
- **行动**：读完后问一句——「所以，下一步是什么？」

## 提取待办的三个句式

1. 如果……就……
2. 为了……，我需要先……
3. 这件事的最小可行动版本是……

> 不需要把每一篇笔记都变成任务。只挑那个让你心里一动、又确实重要的。

试试点开右上角的 AI，让它从这篇笔记里提取真正的行动项。`,
  };

  const review: Note = {
    id: newId(),
    title: "每周回顾 · 模板",
    tags: ["模板", "复盘"],
    pinned: false,
    createdAt: now - 1000 * 60 * 60 * 24 * 6,
    updatedAt: now - 1000 * 60 * 60 * 24 * 3,
    content: `# 每周回顾

留出 20 分钟，给这一周收个尾。

## 1. 回看

- 这周完成了什么？哪些值得记住？
- 哪些事情消耗了精力，却没有带来进展？
- 有什么反复出现的念头？

## 2. 清理

- [ ] 清空收件箱与临时笔记
- [ ] 把零散想法合并进主题笔记
- [ ] 删除或归档已经过期的任务
- [ ] 给下周留出真正重要的 3 件事

## 3. 下周

**三件最重要的事**

1. 
2. 
3. 

**留给自己的话**

> `,
  };

  const ideas: Note = {
    id: newId(),
    title: "灵感收集箱",
    tags: ["灵感"],
    pinned: false,
    createdAt: now - 1000 * 60 * 60 * 8,
    updatedAt: now - 1000 * 60 * 60 * 2,
    content: `# 灵感收集箱

随手记下还没成形的东西。

- 一个关于「慢产品」的想法：不追求每天打开，但每次打开都有用
- 用一句话解释一件事，看看自己是不是真的懂了
- 给每个项目留一页「为什么开始」

## 待整理

- [ ] 把最近读到的三篇文章摘录进来
- [ ] 挑一个想法，写成 200 字`,
  };

  const tasks: Task[] = [
    {
      id: newId(),
      title: "配置自己的 AI 模型",
      description: "在设置里填入 DeepSeek 或任意 OpenAI 兼容接口，让内置 AI 真正开始工作。",
      noteId: welcome.id,
      dueDate: isoDay(0),
      priority: "high",
      done: false,
      completedAt: null,
      createdAt: now - 1000 * 60 * 40,
      updatedAt: now - 1000 * 60 * 40,
    },
    {
      id: newId(),
      title: "用 AI 总结《把知识变成行动》",
      description: "打开笔记，点右上角的闪光图标。",
      noteId: knowledge.id,
      dueDate: isoDay(0),
      priority: "medium",
      done: false,
      completedAt: null,
      createdAt: now - 1000 * 60 * 35,
      updatedAt: now - 1000 * 60 * 35,
    },
    {
      id: newId(),
      title: "整理本周的阅读摘录",
      description: "",
      noteId: ideas.id,
      dueDate: isoDay(1),
      priority: "medium",
      done: false,
      completedAt: null,
      createdAt: now - 1000 * 60 * 30,
      updatedAt: now - 1000 * 60 * 30,
    },
    {
      id: newId(),
      title: "完成第一次每周回顾",
      description: "周日晚上，留 20 分钟。",
      noteId: review.id,
      dueDate: isoDay(4),
      priority: "low",
      done: false,
      completedAt: null,
      createdAt: now - 1000 * 60 * 25,
      updatedAt: now - 1000 * 60 * 25,
    },
    {
      id: newId(),
      title: "创建第一篇笔记",
      description: "已经完成了。",
      noteId: welcome.id,
      dueDate: isoDay(0),
      priority: "low",
      done: true,
      completedAt: now - 1000 * 60 * 60,
      createdAt: now - 1000 * 60 * 60 * 2,
      updatedAt: now - 1000 * 60 * 60,
    },
  ];

  return { notes: [welcome, knowledge, review, ideas], tasks };
}
