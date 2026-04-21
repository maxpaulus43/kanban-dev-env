FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       git \
       curl \
       openssh-client \
       sudo \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 1000 max \
    && useradd --uid 1000 --gid 1000 --create-home --shell /bin/bash max \
    && echo 'max ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers

USER max
WORKDIR /home/max

CMD ["npx", "--yes", "kanban@latest", "--port", "3484"]
