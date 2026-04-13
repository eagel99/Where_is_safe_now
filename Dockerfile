# Pin base image by digest for reproducible, tamper-proof builds.
# To update: docker pull gcr.io/distroless/nodejs22-debian12 && docker inspect --format='{{index .RepoDigests 0}}'
FROM gcr.io/distroless/nodejs22-debian12@sha256:8a3e96fe3345b5d83ecec2066e7c498139a02a6d1214e4f6c39f9ce359f3f5bc

WORKDIR /app

COPY package.json server.mjs index.html israel_cities_2026.csv ./

EXPOSE 3000

USER nonroot

CMD ["server.mjs"]