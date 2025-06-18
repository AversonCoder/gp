import { FastifyInstance, FastifyPluginAsync } from 'fastify';

const root: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.get('/', async (request, reply) => {

    const response = {
      message: '',
      timestamp: new Date().toISOString(),
    };

    return response;
  });
};

export default root;