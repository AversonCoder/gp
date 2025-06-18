import Fastify, {FastifyReply, FastifyRequest} from 'fastify';
import AutoLoad, { AutoloadPluginOptions } from '@fastify/autoload';
import path from 'path';
import axios from "axios";
import { MongoClient, Collection } from 'mongodb';

const fastify = Fastify({
  logger: true
});

const pluginOptions: Partial<AutoloadPluginOptions> = {
  // Place your custom options the autoload plugin below here.
}

fastify.register(AutoLoad, {
  dir: path.join(__dirname, 'plugins'),
  options: pluginOptions
});

fastify.register(AutoLoad, {
  dir: path.join(__dirname, 'routes'),
  options: pluginOptions
});

// 定义项目数据接口
interface ProjectData {
  code?: string;
  ip?: string;
  [key: string]: any;
}

interface Projects {
  [key: string]: ProjectData;
}

// MongoDB配置
let mongoClient: MongoClient | null = null;
let projectsCollection: Collection | null = null;

// 缓存的项目数据
let projects: Projects = {};

// 连接到MongoDB并加载数据
async function connectToMongoDB() {
  try {
    // 尝试使用MONGO_URL (完整URI)
    let uri = process.env.MONGO_URL;

    // 如果没有完整URI，则从组件构建
    if (!uri) {
      const user = process.env.MONGOUSER || 'mongo';
      const password = process.env.MONGOPASSWORD;
      const host = process.env.MONGOHOST || 'mongodb.railway.internal';
      const port = process.env.MONGOPORT || '27017';

      uri = `mongodb://${user}:${password}@${host}:${port}/?authSource=admin`;
    }

    fastify.log.info('正在连接MongoDB...');
    mongoClient = new MongoClient(uri);
    await mongoClient.connect();

    // 设置集合
    const db = mongoClient.db('projectsDB'); // 您可以考虑使用环境变量来配置
    projectsCollection = db.collection('projects');

    fastify.log.info('MongoDB连接成功，正在加载数据...');

    // 加载项目数据
    const documents = await projectsCollection.find({}).toArray();
    projects = {};
    documents.forEach(doc => {
      const { packageName, _id, ...projectData } = doc;
      if (packageName) {
        projects[packageName] = projectData;
      }
    });

    fastify.log.info(`已加载 ${Object.keys(projects).length} 个项目`);
    return true;
  } catch (error) {
    fastify.log.error('MongoDB连接失败:', error);
    return false;
  }
}

// 保存项目
async function saveProject(packageName: string, data: ProjectData) {
  try {
    if (!projectsCollection) {
      fastify.log.warn('MongoDB未连接，无法保存项目');
      return false;
    }

    await projectsCollection.updateOne(
        { packageName },
        { $set: { packageName, ...data } },
        { upsert: true }
    );

    return true;
  } catch (error) {
    fastify.log.error(`保存项目失败:`, error);
    return false;
  }
}

// 检查IP是否来自巴西的函数
async function isIPFromBrazil(ip: string | null): Promise<boolean> {
  if (!ip) return false;

  try {
    const response = await axios.get(
        `https://pro.ip-api.com/json/${ip}?key=Ebxo9R353wjPvHP&lang=zh-CN`,
        { timeout: 5000 }
    );

    if (response.data && response.data.countryCode) {
      return response.data.countryCode === "BR";
    }
    return false;
  } catch (error) {
    fastify.log.error(`检查IP地理位置失败:`, error);
    return false;
  }
}

async function isAccessibleRegion(ip: string | null, countryCode?: string): Promise<boolean> {
  if (!ip || !countryCode) return false;

  try {
    const response = await axios.get(
        `https://pro.ip-api.com/json/${ip}?key=Ebxo9R353wjPvHP&lang=zh-CN`,
        { timeout: 5000 }
    );

    if (response.data && response.data.countryCode) {
      return response.data.countryCode === countryCode;
    }
    return false;
  } catch (error) {
    fastify.log.error(`检查IP地理位置失败:`, error);
    return false;
  }
}

// 列出所有项目的接口
fastify.get("/p/all", async (request: FastifyRequest, reply: FastifyReply) => {
  return projects;
});

// 根据 key 检索项目的接口
fastify.get("/pp/:key", async (request: FastifyRequest<{
  Params: { key: string }
}>, reply: FastifyReply) => {
  const key = request.params.key;
  const projectData = projects[key];

  if (projectData) {
    return projectData;
  } else {
    reply.status(404).send({ error: "Project not found" });
  }
});

// 根据 IP 和 key 检索项目的接口
fastify.get("/br/:key", async (request: FastifyRequest<{
  Params: { key: string }
}>, reply: FastifyReply) => {
  const xForwardedFor = request.headers["x-forwarded-for"] as string | undefined;
  const requestIp = xForwardedFor ? xForwardedFor.split(",")[0].trim() : null;
  const key = request.params.key;
  const projectData = projects[key];

  // 如果 projectData 不存在，提前返回
  if (!projectData) {
    return {};
  }

  // 检查是否有 IP 字段
  if ("ip" in projectData) {
    // 空字符不检查
    if (projectData.ip === "") {
      if (projectData && projectData.code === "2") {
        return projectData;
      } else {
        return {};
      }
    } else {
      const accessible = await isAccessibleRegion(requestIp, projectData.ip);
      if(accessible) {
        if (projectData && projectData.code === "2") {
          return projectData;
        } else {
          return {};
        }
      } else {
        return {};
      }
    }
  } else {
    // 没有 IP 字段时，检查巴西 IP
    const fromBrazil = await isIPFromBrazil(requestIp);
    if (fromBrazil) {
      if (projectData && projectData.code === "2") {
        return projectData;
      } else {
        return {};
      }
    } else if (projectData.code === "1") {
      return {};
    }
    return {};
  }
});

// 更新项目的接口
fastify.post("/p/update/:key", async (request: FastifyRequest<{
  Params: { key: string },
  Body: ProjectData
}>, reply: FastifyReply) => {
  const data = request.body;
  const key = request.params.key;

  // 更新内存缓存
  projects[key] = data;

  // 保存到MongoDB - 修复了TS6133错误
  await saveProject(key, data);  // 移除了未使用的success变量

  // 即使MongoDB保存失败，我们也返回成功
  return reply.status(200).send("{}");
});

// 健康检查
fastify.get('/health', async () => {
  let dbStatus = 'disconnected';

  if (mongoClient && projectsCollection) {
    try {
      // 获取随机文档
      const result = await projectsCollection.aggregate([{ $sample: { size: 1 } }]).toArray();
      dbStatus = result.length > 0 ? 'connected' : 'empty';
    } catch (error) {
      dbStatus = 'error';
    }
  }

  return {
    status: 'ok',
    mongodb: dbStatus,
    projectCount: Object.keys(projects).length
  };
});

// 启动服务器
const start = async () => {
  try {
    // 尝试连接数据库，但不阻止服务器启动
    const connected = await connectToMongoDB();
    if (!connected) {
      fastify.log.warn('MongoDB连接失败，服务将继续以有限功能运行');
    }

    // 无论数据库是否连接，都启动HTTP服务器
    await fastify.listen({
      host: '::',
      port: Number(process.env.PORT) || 3000
    });

    fastify.log.info(`服务已启动在端口 ${process.env.PORT || 3000}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

// 处理Promise，修复"Promise returned from start is ignored"警告
start().catch(err => {
  fastify.log.error('启动失败:', err);
  process.exit(1);
});

// 优雅退出
process.on('SIGINT', async () => {
  await fastify.close();
  if (mongoClient) await mongoClient.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await fastify.close();
  if (mongoClient) await mongoClient.close();
  process.exit(0);
});

export default fastify;