#!/bin/sh
chmod -R 777 ./dist
chmod -R 777 ./lib
yarn build:client 
yarn build:server
chmod -R 555 ./dist
chmod -R 555 ./lib
