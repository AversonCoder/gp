import { FastifyInstance, FastifyPluginAsync } from 'fastify';

const root: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.get('/', async (request, reply) => {
    // 重定向到欢迎页面
    return reply.redirect('/public/index.html');
  });
};

export default root;