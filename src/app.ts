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

// MongoDB配置 - 使用正确的配置
const dbName = 'projectsDB';  // 或考虑使用 'test' 或 'admin'
const collectionName = 'projects';
let mongoClient: MongoClient | null = null;
let projectsCollection: Collection | null = null;

// 缓存的项目数据
let projects: Projects = {};

// 从Railway环境变量获取MongoDB连接URL - 优先使用内部连接
function getMongoConnectionUrl(): string {
  // 直接使用MONGO_URL如果可用
  if (process.env.MONGO_URL) {
    fastify.log.info('使用MONGO_URL环境变量连接');
    return process.env.MONGO_URL;
  }

  // 否则构建连接URL
  const host = process.env.MONGOHOST || 'mongodb.railway.internal';
  const port = process.env.MONGOPORT || '27017';
  const user = process.env.MONGOUSER || 'mongo';
  const password = process.env.MONGOPASSWORD;

  if (host && port && user && password) {
    // 构建安全的内部连接URL，并添加authSource=admin
    return `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/?authSource=admin`;
  }

  throw new Error('无法获取有效的MongoDB连接信息');
}

// 初始化MongoDB连接
async function initMongoDB() {
  try {
    const url = getMongoConnectionUrl();
    fastify.log.info(`正在连接到MongoDB... (敏感信息已隐藏)`);

    mongoClient = new MongoClient(url, {
      connectTimeoutMS: 10000,
      socketTimeoutMS: 45000,
      serverSelectionTimeoutMS: 15000,
    });

    await mongoClient.connect();

    fastify.log.info('MongoDB基础连接成功，正在选择数据库...');

    // 尝试列出可用的数据库 - 这有助于调试
    const adminDb = mongoClient.db('admin');
    const dbs = await adminDb.admin().listDatabases();
    fastify.log.info('可用的数据库:', dbs.databases.map(db => db.name).join(', '));

    // 使用数据库
    const db = mongoClient.db(dbName);
    projectsCollection = db.collection(collectionName);

    // 测试连接
    await db.command({ ping: 1 });
    fastify.log.info(`MongoDB连接成功，使用数据库: ${dbName}`);

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
    // 更详细的错误日志
    fastify.log.error('MongoDB连接或数据加载失败:', error);

    if (error instanceof Error) {
      fastify.log.error(`错误类型: ${error.name}, 消息: ${error.message}`);
      if (error.stack) {
        fastify.log.error(`堆栈: ${error.stack}`);
      }
    }

    // 不要立即退出，而是将MongoDB标记为不可用
    fastify.log.warn('MongoDB不可用，应用将以有限功能继续运行');
    return false; // 返回false而不是退出
  }
}

// 保存项目到MongoDB - 添加更多错误处理
async function saveProject(packageName: string, data: ProjectData) {
  try {
    if (!projectsCollection) {
      fastify.log.warn('MongoDB集合未初始化，无法保存项目');
      return false;
    }

    await projectsCollection.updateOne(
        { packageName },
        { $set: { packageName, ...data } },
        { upsert: true }
    );

    fastify.log.info(`项目 ${packageName} 已保存`);
    return true;
  } catch (error) {
    fastify.log.error(`保存项目失败 (${packageName}):`, error);
    return false;
  }
}

// 检查IP是否来自巴西的函数
async function isIPFromBrazil(ip: string | null): Promise<boolean> {
  if (!ip) return false;

  try {
    const response = await axios.get(
        `https://pro.ip-api.com/json/${ip}?key=Ebxo9R353wjPvHP&lang=zh-CN`,
        { timeout: 5000 } // 添加超时
    );

    if (response.data && response.data.countryCode) {
      fastify.log.debug(`IP ${ip} 的国家代码: ${response.data.countryCode}`);
      return response.data.countryCode === "BR";
    }
    return false;
  } catch (error) {
    fastify.log.error(`检查IP地理位置失败 (${ip}):`, error);
    return false;
  }
}

async function isAccessibleRegion(ip: string | null, countryCode?: string): Promise<boolean> {
  if (!ip || !countryCode) return false;

  try {
    const response = await axios.get(
        `https://pro.ip-api.com/json/${ip}?key=Ebxo9R353wjPvHP&lang=zh-CN`,
        { timeout: 5000 } // 添加超时
    );

    if (response.data && response.data.countryCode) {
      fastify.log.debug(`IP ${ip} 的国家代码: ${response.data.countryCode}`);
      return response.data.countryCode === countryCode;
    }
    return false;
  } catch (error) {
    fastify.log.error(`检查IP地理位置失败 (${ip}):`, error);
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
    fastify.log.info("没有 IP 字段时，检查巴西 IP");
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

  // 保存到MongoDB
  const success = await saveProject(key, data);

  if (success) {
    return reply.status(200).send("{}");
  } else {
    // 即使MongoDB保存失败，仍然返回成功，因为内存缓存已更新
    fastify.log.warn(`项目 ${key} 已存储在内存中，但未能保存到MongoDB`);
    return reply.status(200).send("{}");
  }
});

// 添加更详细的健康检查端点
fastify.get('/health', async () => {
  let dbStatus = 'not_connected';
  let dbVersion = null;

  if (mongoClient) {
    try {
      const adminDb = mongoClient.db('admin');
      const serverInfo = await adminDb.command({ buildInfo: 1 });
      dbStatus = 'connected';
      dbVersion = serverInfo.version;
    } catch (error) {
      dbStatus = 'error';
      fastify.log.error('健康检查期间MongoDB连接失败:', error);
    }
  }

  return {
    status: 'ok',
    mongo: {
      status: dbStatus,
      version: dbVersion,
      host: process.env.MONGOHOST || 'unknown',
      database: dbName
    },
    projects: Object.keys(projects).length
  };
});

// 启动服务器前初始化MongoDB
const start = async () => {
  try {
    // 连接MongoDB并加载数据，但不在失败时终止
    const mongoConnected = await initMongoDB();

    if (!mongoConnected) {
      fastify.log.warn('MongoDB连接失败，应用将以有限功能运行');
    }

    // 无论MongoDB是否连接成功，都启动HTTP服务器
    await fastify.listen({
      host: '::',
      port: Number(process.env.PORT) || 3000
    });

    fastify.log.info(`服务器已启动，监听端口: ${process.env.PORT || 3000}`);
  } catch (err) {
    fastify.log.error('启动服务器失败:', err);
    process.exit(1);
  }
};

// 启动应用
start();

// 优雅退出
process.on('SIGINT', async () => {
  fastify.log.info('收到SIGINT信号，正在关闭...');
  await fastify.close();
  if (mongoClient) {
    await mongoClient.close();
    fastify.log.info('MongoDB连接已关闭');
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  fastify.log.info('收到SIGTERM信号，正在关闭...');
  await fastify.close();
  if (mongoClient) {
    await mongoClient.close();
    fastify.log.info('MongoDB连接已关闭');
  }
  process.exit(0);
});

// 导出，以便在测试中使用
export default fastify;