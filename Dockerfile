# Pin base image by digest for reproducible, tamper-proof builds.
# To update: docker pull gcr.io/distroless/nodejs22-debian12 && docker inspect --format='{{index .RepoDigests 0}}'
FROM gcr.io/distroless/nodejs22-debian12@sha256:b6979727090b276e7d0e05e87f774bc0feb2509a44927d1bb8f780851d691568

WORKDIR /app

COPY package.json server.mjs index.html israel_cities_2026.csv ./

EXPOSE 3000

USER nonroot

CMD ["server.mjs"]