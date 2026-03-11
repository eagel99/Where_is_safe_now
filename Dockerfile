FROM gcr.io/distroless/nodejs22-debian12

WORKDIR /app

COPY package.json server.mjs index.html israel_cities_2026.csv ./

EXPOSE 3000

USER nonroot

CMD ["server.mjs"]