FROM ubuntu:xenial


RUN apt-get -y update
RUN apt-get install -y software-properties-common
RUN add-apt-repository -y ppa:ubuntu-toolchain-r/test
RUN apt-get -y update
RUN apt-get -y install curl wget protobuf-c-compiler

#Use UTF8 to avoid encoding problems with pgsql
RUN apt-get -y install locales
ENV LANG C.UTF-8
RUN locale-gen en_US.UTF-8
RUN update-locale LANG=en_US.UTF-8

#Add 6.X node ppa
RUN curl -sL https://deb.nodesource.com/setup_6.x | bash
RUN apt-get -y install make libpixman-1-dev pkg-config postgresql-9.5 libcairo2-dev  libjpeg8-dev libgif-dev libpango1.0-dev libgdal1i libgeos-dev libxml2-dev libgdal-dev libproj-dev postgresql-server-dev-9.5 redis-server nodejs gcc-4.9 g++-4.9 libprotobuf-c-dev git postgresql-plpython-9.5 libjson-c-dev

# Install PostGIS 2.4 from sources
RUN wget http://download.osgeo.org/postgis/source/postgis-2.4.0.tar.gz && tar xvfz postgis-2.4.0.tar.gz && cd postgis-2.4.0 && ./configure && make && make install && cd .. && rm -rf postgis-2.4.0

# Configure PostgreSQL
RUN echo "local     all       all                     trust" > /etc/postgresql/9.5/main/pg_hba.conf
RUN echo "host      all       all       0.0.0.0/0     trust" >> /etc/postgresql/9.5/main/pg_hba.conf
RUN echo "host      all       all       ::1/128       trust" >> /etc/postgresql/9.5/main/pg_hba.conf
RUN echo "listen_addresses='*'" >> /etc/postgresql/9.5/main/postgresql.conf

RUN apt-get -y remove wget protobuf-c-compiler
RUN apt-get -y autoremove

WORKDIR /srv
CMD export NPROCS=1 && export JOBS=1 && export CXX=g++-4.9 && npm install && export PGUSER=postgres && /etc/init.d/postgresql start && createdb template_postgis && createuser publicuser && psql -c "CREATE EXTENSION postgis" template_postgis && npm test
