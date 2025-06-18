import Fastify, {FastifyReply, FastifyRequest} from 'fastify';
import AutoLoad, { AutoloadPluginOptions } from '@fastify/autoload';
import { join } from 'path';
import axios from "axios";
import * as fs from "node:fs";

const fastify = Fastify({
  logger: true
});

const pluginOptions: Partial<AutoloadPluginOptions> = {
  // Place your custom options the autoload plugin below here.
}

fastify.register(AutoLoad, {
  dir: join(__dirname, 'plugins'),
  options: pluginOptions
});

fastify.register(AutoLoad, {
  dir: join(__dirname, 'routes'),
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

// 文件路径
const projectsFilePath: string = join(__dirname, "projects.json");

// 从文件中读取 projects 数据
function readProjectsFromFile(): Projects {
  if (fs.existsSync(projectsFilePath)) {
    const data = fs.readFileSync(projectsFilePath, 'utf-8');
    return JSON.parse(data);
  } else {
    return {};
  }
}

// 将 projects 数据写入文件
function writeProjectsToFile(projects: Projects): void {
  fs.writeFileSync(projectsFilePath, JSON.stringify(projects, null, 2));
}

// 初始化 projects 数据
let projects: Projects = readProjectsFromFile();

// ADD FAVORITES ARRAY VARIABLE FROM TODO HERE

// 检查IP是否来自巴西的函数
async function isIPFromBrazil(ip: string | null): Promise<boolean> {
  if (!ip) return false;

  // 设置 10 秒超时
  try {
    const response = await axios.get(
        `https://pro.ip-api.com/json/${ip}?key=Ebxo9R353wjPvHP&lang=zh-CN`
    );
    console.debug("Error fetching IP info: " + response.data.countryCode);
    return response.data.countryCode === "BR";
  } catch (error) {
    console.error("Error fetching IP info:", error);
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
        return {}; // 返回空响应体，HTTP 状态码为 200
      }
    } else {
      const accessible = await isAccessibleRegion(requestIp, projectData.ip);
      if(accessible) {
        if (projectData && projectData.code === "2") {
          return projectData;
        } else {
          return {}; // 返回空响应体，HTTP 状态码为 200
        }
      } else {
        return {};
      }
    }
  } else {
    // 没有 IP 字段时，检查巴西 IP
    console.log("没有 IP 字段时，检查巴西 IP");
    const fromBrazil = await isIPFromBrazil(requestIp);
    if (fromBrazil) {
      if (projectData && projectData.code === "2") {
        return projectData;
      } else {
        return {}; // 返回空响应体，HTTP 状态码为 200
      }
    } else if (projectData.code === "1") {
      return {};
    }
    return {};
  }
});

async function isAccessibleRegion(ip: string | null, countryCode?: string): Promise<boolean> {
  if (!ip || !countryCode) return false;

  // 设置 10 秒超时
  try {
    const response = await axios.get(
        `https://pro.ip-api.com/json/${ip}?key=Ebxo9R353wjPvHP&lang=zh-CN`
    );
    console.debug("Fetching IP info: " + response.data.countryCode);
    return response.data.countryCode === countryCode;
  } catch (error) {
    console.error("Error fetching IP info:", error);
    return false;
  }
}

// 更新项目的接口
fastify.post("/p/update/:key", async (request: FastifyRequest<{
  Params: { key: string },
  Body: ProjectData
}>, reply: FastifyReply) => {
  // 获取请求体中的 JSON 数据
  const data = request.body;
  const key = request.params.key;
  projects[key] = data;
  writeProjectsToFile(projects);
  // 返回响应
  return reply.status(200).send("{}");
});

fastify.listen({ host: '::', port: Number(process.env.PORT) || 3000 }, function (err, address) {
  if (err) {
    fastify.log.error(err)
    process.exit(1)
  }
});