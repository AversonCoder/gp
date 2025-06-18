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
const dbName = 'projectsDB';
const collectionName = 'projects';
let mongoClient: MongoClient | null = null;
let projectsCollection: Collection | null = null;

// 缓存的项目数据
let projects: Projects = {};

// 从Railway环境变量获取MongoDB连接URL
function getMongoConnectionUrl(): string {
  if (process.env.MONGO_URL) {
    return process.env.MONGO_URL;
  }

  const user = process.env.MONGOUSER || 'mongo';
  const password = process.env.MONGOPASSWORD;
  const host = process.env.MONGOHOST || 'mongodb.railway.internal';
  const port = process.env.MONGOPORT || '27017';

  return `mongodb://${user}:${password}@${host}:${port}`;
}

// 初始化MongoDB连接
async function initMongoDB() {
  try {
    const url = getMongoConnectionUrl();
    mongoClient = new MongoClient(url);
    await mongoClient.connect();

    const db = mongoClient.db(dbName);
    projectsCollection = db.collection(collectionName);

    // 加载项目数据
    const documents = await projectsCollection.find({}).toArray();
    projects = {};
    documents.forEach(doc => {
      const { packageName, _id, ...projectData } = doc;
      if (packageName) {
        projects[packageName] = projectData;
      }
    });

    fastify.log.info('MongoDB连接成功，已加载项目数据');
    return true;
  } catch (error) {
    fastify.log.error('MongoDB连接或数据加载失败:', error);
    return false;
  }
}

// 保存项目到MongoDB
async function saveProject(packageName: string, data: ProjectData) {
  try {
    if (projectsCollection) {
      await projectsCollection.updateOne(
          { packageName },
          { $set: { packageName, ...data } },
          { upsert: true }
      );
      return true;
    }
    return false;
  } catch (error) {
    fastify.log.error(`保存项目失败: ${error}`);
    return false;
  }
}

// 检查IP是否来自巴西的函数
async function isIPFromBrazil(ip: string | null): Promise<boolean> {
  if (!ip) return false;

  try {
    const response = await axios.get(
        `https://pro.ip-api.com/json/${ip}?key=Ebxo9R353wjPvHP&lang=zh-CN`
    );
    fastify.log.debug("IP info: " + response.data.countryCode);
    return response.data.countryCode === "BR";
  } catch (error) {
    fastify.log.error("Error fetching IP info:", error);
    return false;
  }
}

async function isAccessibleRegion(ip: string | null, countryCode?: string): Promise<boolean> {
  if (!ip || !countryCode) return false;

  try {
    const response = await axios.get(
        `https://pro.ip-api.com/json/${ip}?key=Ebxo9R353wjPvHP&lang=zh-CN`
    );
    fastify.log.debug("IP info: " + response.data.countryCode);
    return response.data.countryCode === countryCode;
  } catch (error) {
    fastify.log.error("Error fetching IP info:", error);
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
  await saveProject(key, data);

  return reply.status(200).send("{}");
});

// 启动服务器前初始化MongoDB
const start = async () => {
  try {
    // 连接MongoDB并加载数据
    await initMongoDB();

    // 启动HTTP服务器
    await fastify.listen({
      host: '::',
      port: Number(process.env.PORT) || 3000
    });

  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

// 启动应用
start();

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

// 导出，以便在测试中使用
export default fastify;