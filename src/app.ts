/**
 * MongoDB与Fastify集成应用
 * 这个应用提供项目数据的存储和检索功能，具有区域检测特性
 */

import Fastify, {FastifyReply, FastifyRequest} from 'fastify';
import AutoLoad, {AutoloadPluginOptions} from '@fastify/autoload';
import path from 'path';
import axios from "axios";
import {Collection, MongoClient} from 'mongodb';

/**
 * 创建Fastify实例，启用日志记录
 */
const fastify = Fastify({
    logger: true
});

/**
 * 自动加载插件配置
 */
const pluginOptions: Partial<AutoloadPluginOptions> = {}

/**
 * 注册plugins目录下的所有插件
 */
fastify.register(AutoLoad, {
    dir: path.join(__dirname, 'plugins'),
    options: pluginOptions
});

/**
 * 注册routes目录下的所有路由
 */
fastify.register(AutoLoad, {
    dir: path.join(__dirname, 'routes'),
    options: pluginOptions
});

/**
 * 项目数据接口定义
 * code: 项目代码，决定项目是否可见
 * ip: 限制访问的国家代码
 */
interface ProjectData {
    code?: string;        // 项目代码，"1"=隐藏，"2"=显示
    ip?: string;          // 限制访问的国家代码
    packageName?: string; // 包名标识
    [key: string]: any;   // 其他自定义字段
}

/**
 * MongoDB相关变量
 */
let mongoClient: MongoClient | null = null;              // MongoDB客户端连接
let projectsCollection: Collection | null = null;        // 项目集合引用

/**
 * 连接到MongoDB
 * 尝试使用环境变量中的MongoDB连接信息，优先使用MONGO_URL
 * @returns {Promise<boolean>} 连接是否成功
 */
async function connectToMongoDB(): Promise<boolean> {
    try {
        // 获取MongoDB连接URI
        let uri = process.env.MONGO_URL;

        // 如果没有MONGO_URL，则从各组件构建连接字符串
        if (!uri) {
            const user = process.env.MONGOUSER || 'mongo';
            const password = process.env.MONGOPASSWORD;
            const host = process.env.MONGOHOST || 'mongodb.railway.internal';
            const port = process.env.MONGOPORT || '27017';

            // 包含authSource=admin以确保正确的身份验证数据库
            uri = `mongodb://${user}:${password}@${host}:${port}/?authSource=admin`;
        }

        fastify.log.info('正在连接MongoDB...');

        // 创建MongoDB客户端并连接
        mongoClient = new MongoClient(uri);
        await mongoClient.connect();

        // 选择数据库和集合
        const db = mongoClient.db('projectsDB');
        projectsCollection = db.collection('projects');

        // 测试连接
        await db.command({ ping: 1 });
        fastify.log.info('MongoDB连接成功');

        return true;
    } catch (error) {
        // 记录错误但不终止应用
        fastify.log.error('MongoDB连接失败:', error);
        return false;
    }
}

/**
 * 根据packageName获取项目数据
 * @param {string} packageName - 项目的唯一标识符
 * @returns {Promise<ProjectData|null>} 项目数据或null
 */
async function getProject(packageName: string): Promise<ProjectData|null> {
    try {
        if (!projectsCollection) {
            fastify.log.warn('MongoDB未连接，无法获取项目');
            return null;
        }

        const doc = await projectsCollection.findOne({ packageName });
        if (!doc) return null;

        // 移除_id字段
        const { _id, ...projectData } = doc;
        return projectData;
    } catch (error) {
        fastify.log.error(`获取项目失败:`, error);
        return null;
    }
}

/**
 * 获取所有项目数据
 * @returns {Promise<Record<string, ProjectData>>} 所有项目数据，以packageName为键
 */
async function getAllProjects(): Promise<Record<string, ProjectData>> {
    try {
        if (!projectsCollection) {
            fastify.log.warn('MongoDB未连接，无法获取项目');
            return {};
        }

        const documents = await projectsCollection.find({}).toArray();
        const projects: Record<string, ProjectData> = {};

        documents.forEach(doc => {
            const { packageName, _id, ...projectData } = doc;
            if (packageName) {
                projects[packageName] = projectData;
            }
        });

        return projects;
    } catch (error) {
        fastify.log.error(`获取所有项目失败:`, error);
        return {};
    }
}

/**
 * 将项目数据保存到MongoDB
 * @param {string} packageName - 项目的唯一标识符
 * @param {ProjectData} data - 要保存的项目数据
 * @returns {Promise<boolean>} 操作是否成功
 */
async function saveProject(packageName: string, data: ProjectData): Promise<boolean> {
    try {
        if (!projectsCollection) {
            fastify.log.warn('MongoDB未连接，无法保存项目');
            return false;
        }

        // 使用upsert确保如果记录不存在则创建
        await projectsCollection.updateOne(
            {packageName},
            {$set: {packageName, ...data}},
            {upsert: true}
        );

        return true;
    } catch (error) {
        fastify.log.error(`保存项目失败:`, error);
        return false;
    }
}

/**
 * 检查IP是否来自巴西
 * @param {string|null} ip - 要检查的IP地址
 * @returns {Promise<boolean>} 是否来自巴西
 */
async function isIPFromBrazil(ip: string | null): Promise<boolean> {
    if (!ip) return false;

    try {
        // 使用IP-API服务检查IP地理位置
        const response = await axios.get(
            `https://pro.ip-api.com/json/${ip}?key=Ebxo9R353wjPvHP&lang=zh-CN`,
            {timeout: 5000} // 设置超时避免长时间等待
        );

        // 检查返回的国家代码是否为巴西(BR)
        if (response.data && response.data.countryCode) {
            return response.data.countryCode === "BR";
        }
        return false;
    } catch (error) {
        fastify.log.error(`检查IP地理位置失败:`, error);
        return false;
    }
}

/**
 * 检查IP是否来自指定国家
 * @param {string|null} ip - 要检查的IP地址
 * @param {string|undefined} countryCode - 目标国家代码
 * @returns {Promise<boolean>} 是否来自指定国家
 */
async function isAccessibleRegion(ip: string | null, countryCode?: string): Promise<boolean> {
    if (!ip || !countryCode) return false;

    try {
        // 使用IP-API服务检查IP地理位置
        const response = await axios.get(
            `https://pro.ip-api.com/json/${ip}?key=Ebxo9R353wjPvHP&lang=zh-CN`,
            {timeout: 5000}
        );

        // 检查返回的国家代码是否匹配
        if (response.data && response.data.countryCode) {
            return response.data.countryCode === countryCode;
        }
        return false;
    } catch (error) {
        fastify.log.error(`检查IP地理位置失败:`, error);
        return false;
    }
}

/**
 * API端点：获取所有项目数据
 */
fastify.get("/p/all", async (request: FastifyRequest, reply: FastifyReply) => {
    return await getAllProjects();
});

/**
 * API端点：根据键名获取特定项目
 */
fastify.get("/pp/:key", async (request: FastifyRequest<{
    Params: { key: string }
}>, reply: FastifyReply) => {
    const key = request.params.key;
    const projectData = await getProject(key);

    if (projectData) {
        return projectData;
    } else {
        reply.status(404).send({error: "Project not found"});
    }
});

/**
 * API端点：根据IP地理位置和项目配置决定是否返回项目数据
 * 这个端点实现了基于区域的访问控制
 */
fastify.get("/br/:key", async (request: FastifyRequest<{
    Params: { key: string }
}>, reply: FastifyReply) => {
    // 获取请求的IP地址
    const xForwardedFor = request.headers["x-forwarded-for"] as string | undefined;
    const requestIp = xForwardedFor ? xForwardedFor.split(",")[0].trim() : null;
    const key = request.params.key;
    const projectData = await getProject(key);

    // 如果项目不存在，返回空对象
    if (!projectData) {
        return {};
    }

    // 根据项目配置和请求IP执行区域检查
    if ("ip" in projectData) {
        // 情况1: 如果ip字段为空字符串，则不进行地理位置检查
        if (projectData.ip === "") {
            if (projectData.code === "2") {
                return projectData;  // 可见项目
            } else {
                return {};  // 隐藏项目
            }
        } else {
            // 情况2: 检查IP是否来自项目指定的国家
            const accessible = await isAccessibleRegion(requestIp, projectData.ip);
            if (accessible) {
                if (projectData.code === "2") {
                    return projectData;  // 可见项目
                } else {
                    return {};  // 隐藏项目
                }
            } else {
                return {};  // 区域不匹配
            }
        }
    } else {
        // 情况3: 无ip字段，检查是否来自巴西（默认行为）
        const fromBrazil = await isIPFromBrazil(requestIp);
        if (fromBrazil) {
            if (projectData.code === "2") {
                return projectData;  // 来自巴西且项目可见
            } else {
                return {};  // 来自巴西但项目隐藏
            }
        } else if (projectData.code === "1") {
            return {};  // 不是来自巴西且项目隐藏
        }
        return {};  // 默认返回空
    }
});

/**
 * API端点：更新项目数据
 */
fastify.post("/p/update/:key", async (request: FastifyRequest<{
    Params: { key: string },
    Body: ProjectData
}>, reply: FastifyReply) => {
    const data = request.body;
    const key = request.params.key;

    // 保存到MongoDB
    const success = await saveProject(key, data);
    if (!success) {
        fastify.log.warn(`项目 ${key} 保存失败`);
        // 如果保存失败，仍然返回成功码，但记录日志
    }

    // 返回成功响应
    return reply.status(200).send("{}");
});

/**
 * API端点：健康检查
 * 返回应用和MongoDB连接状态
 */
fastify.get('/health', async () => {
    let dbStatus = 'disconnected';
    let projectCount = 0;

    if (mongoClient && projectsCollection) {
        try {
            // 从MongoDB获取一个随机文档来验证连接
            const result = await projectsCollection.aggregate([{$sample: {size: 1}}]).toArray();
            dbStatus = result.length > 0 ? 'connected' : 'empty';

            // 获取项目计数
            projectCount = await projectsCollection.countDocuments();
        } catch (error) {
            dbStatus = 'error';
        }
    }

    return {
        status: 'ok',
        mongodb: dbStatus,
        projectCount,
        timestamp: new Date().toISOString()
    };
});

/**
 * 启动服务器
 * 连接MongoDB并启动HTTP服务
 */
const start = async () => {
    try {
        // 尝试连接数据库，但即使失败也继续启动服务器
        const connected = await connectToMongoDB();
        if (!connected) {
            fastify.log.warn('MongoDB连接失败，服务将继续运行但功能受限');
        }

        // 启动HTTP服务器
        await fastify.listen({
            host: '::',  // 同时支持IPv4和IPv6
            port: Number(process.env.PORT) || 3000
        });

        fastify.log.info(`服务已启动在端口 ${process.env.PORT || 3000}`);
    } catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
};

// 处理start()返回的Promise
start().catch(err => {
    fastify.log.error('启动失败:', err);
    process.exit(1);
});

/**
 * 优雅退出处理
 * 当收到SIGINT或SIGTERM信号时，关闭服务器和数据库连接
 */
process.on('SIGINT', async () => {
    fastify.log.info('收到SIGINT信号，正在关闭服务...');
    await fastify.close();
    if (mongoClient) await mongoClient.close();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    fastify.log.info('收到SIGTERM信号，正在关闭服务...');
    await fastify.close();
    if (mongoClient) await mongoClient.close();
    process.exit(0);
});

// 导出fastify实例，用于测试
export default fastify;