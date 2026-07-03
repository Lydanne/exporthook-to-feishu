const axios = require("axios");
const { basename } = require("path");

const fastify = require("fastify")({ logger: true });

// Declare a route
fastify.post("/notify/feishu", async (request, reply) => {
  const link = `https://${request.query.link}`;

  const { jobQueue, jobId, status, result, error, cost, startAt, payload } =
    request.body;

  let message = `# 导出完成\n队列名称：${jobQueue}\n任务编号：${jobId}\n创建时间：${new Date(
    startAt
  ).toLocaleString()}\n花费时间：${cost / 1000}s`;
  const code = result.code || 0;
  if (status === "completed" && code === 0) {
    message += `
文件名称：${basename(decodeURIComponent(result.url))}
导出状态：成功
文件链接：${result.url}
文件大小：${result.size / 1024 / 1024}MB
文件数量：${result.count}`;
  } else {
    message += `
导出状态：失败(status: ${status}, code: ${code})
错误信息：${error === "null" ? result.msg : error}`;
  }

  message += `\n用户Openid: ${payload.openid}\n\n[查看详情](http://120.53.222.157:9001/xgj-export-test/${jobQueue}/${jobId})`;

  const res = await axios.post(link, {
    msg_type: "text", // 指定消息类型
    content: {
      // 消息内容主体
      text: message,
    },
  });

  return res.data;
});

// Run the server!
const start = async () => {
  try {
    await fastify.listen({ port: Number(process.env.PORT || 8001) });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};
start();
