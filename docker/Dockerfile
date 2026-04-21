FROM ubuntu:22.04

ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \
    git \
    curl \
    wget \
    sudo \
    locales \
    build-essential \
    && rm -rf /var/lib/apt/lists/* \
    && locale-gen en_US.UTF-8

ENV LANG=en_US.UTF-8
ENV LANGUAGE=en_US:en
ENV LC_ALL=en_US.UTF-8

RUN useradd -m -s /bin/bash max \
    && echo 'max ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers

USER max
WORKDIR /home/max

ENV PATH="/home/max/.local/share/mise/shims:/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:${PATH}"
ENV SHELL="fish"

RUN git clone https://github.com/maxpaulus43/dotfiles.git ~/c/dotfiles
RUN cd ~/c/dotfiles && chmod +x bin/bootstrap.sh && bin/bootstrap.sh

CMD ["fish"]
