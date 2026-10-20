import http from 'node:http';

const sample = `今天真正重要的，不是把清单全部划掉，而是先完成**「配置自己的 AI 模型」**。

它会让接下来的总结、提取待办和知识检索都变得顺手。做完这一件，再回到另外两件小事。

给自己留十分钟，不被打断。`;

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method !== 'POST' || !req.url?.includes('/chat/completions')) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(raw); } catch {}
    const messages = body.messages || [];
    const user = messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
    const stream = body.stream !== false;

    let reply = sample;
    if (user.includes('只回复') || user.includes('连接测试')) reply = '连接成功';
    else if (user.includes('只返回一个 JSON 数组') || user.includes('只输出 JSON')) {
      reply = '```json\n[{"title":"配置 DeepSeek API Key","dueDate":null,"priority":"high"},{"title":"总结《把知识变成行动》","dueDate":null,"priority":"medium"},{"title":"整理本周阅读摘录","dueDate":null,"priority":"low"}]\n```';
    } else if (user.includes('5 个简洁、有吸引力的中文标题')) {
      reply = '慢下来，才能看清方向\n把知识变成下一步\n在纸页之间，找到行动\n写给未来的自己\n一页，一件重要的事';
    } else if (user.includes('接着写') || user.includes('继续写 150')) {
      reply = '也许真正需要整理的不是更多信息，而是那些已经在心里盘旋很久、却始终没有落笔的问题。先挑一个，把它写成一句能被行动的话。剩下的，等做完再想。';
    } else if (user.includes('请总结下面这篇笔记')) {
      reply = '这篇笔记在讲一件事：**笔记的价值不在收藏，而在能否推动一个具体的下一步。**\n\n- 先捕捉，再连接，最后落到行动\n- 用标签和双向链接建立知识网络\n- 每篇笔记读完，只问一句「所以，下一步是什么？」\n\n下一步：挑一篇最近的笔记，标出一个可以在今天完成的小动作。';
    } else if (user.includes('规划今天')) {
      reply = `今天你有两件事：配置 AI 模型，以及用 AI 总结《把知识变成行动》。\n\n建议先做 **配置自己的 AI 模型**。它只需要十分钟，却能让后面所有与 AI 有关的动作都变得可用。完成后再去总结笔记，会顺手很多。\n\n不必两件都做完。先把第一件真正做完。`;
    } else if (user.includes('最近在想什么')) {
      reply = `从最近的笔记里，能看到两条反复出现的线索：\n\n一是**「慢产品」**——不追求每天打开，但每次打开都有用。二是**「用一句话解释一件事」**，你在用它检验自己是否真的理解。\n\n它们其实指向同一个问题：你更在意留下什么，而不是收集多少。下一步也许是把「慢产品」写成一篇更完整的笔记。`;
    }

    if (!stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: reply } }] }));
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] })}\n\n`);
    const chunks = reply.match(/[\s\S]{1,8}/g) || [];
    let i = 0;
    const timer = setInterval(() => {
      if (i >= chunks.length) {
        clearInterval(timer);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunks[i++] } }] })}\n\n`);
    }, 18);
    res.on('close', () => clearInterval(timer));
  });
});
server.listen(4319, '127.0.0.1', () => console.log('mock AI listening on 4319'));
