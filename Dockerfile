# Override the base image if Docker Hub is rate-limited for you, e.g.
#   docker build --build-arg BASE=public.ecr.aws/docker/library/node:20-alpine .
ARG BASE=node:20-alpine
FROM ${BASE}
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
# npm ls fails the build if any dependency is missing (npm can exit 0 on a broken install)
RUN npm ci --omit=dev && npm ls --omit=dev
COPY server ./server
COPY public ./public
EXPOSE 3000
ENV PORT=3000
USER node
CMD ["node", "server/index.js"]
