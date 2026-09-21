# BUILD
FROM node:22-alpine as builder

WORKDIR /opt/src

RUN apk add --no-cache bash git python3 perl alpine-sdk

COPY synthetic-monitor-server synthetic-monitor-server

RUN cd synthetic-monitor-server && \
    npm ci && \
    npm run build

# RUN
FROM node:22-alpine

COPY --from=builder /opt/src/synthetic-monitor-server/node_modules /opt/app/synthetic-monitor/node_modules
COPY --from=builder /opt/src/synthetic-monitor-server/dist /opt/app/synthetic-monitor/dist
COPY synthetic-monitor-server/config.json /opt/app/synthetic-monitor/config.json
COPY package.json /opt/app/synthetic-monitor/package.json

WORKDIR /opt/app/synthetic-monitor

CMD [ "dist/App.js" ]
