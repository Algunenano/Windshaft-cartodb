'use strict';

var assert = require('../support/assert');
var _ = require('underscore');
var redis = require('redis');
var step = require('step');
var strftime = require('strftime');
var QueryTables = require('cartodb-query-tables').queryTables;
var NamedMapsCacheEntry = require('../../lib/cache/model/named-maps-entry');
var redisStatsDb = 5;

// Pollute the PG environment to make sure
// configuration settings are always enforced
// See https://github.com/CartoDB/Windshaft-cartodb/issues/174
process.env.PGPORT = '666';
process.env.PGHOST = 'fake';

var path = require('path');
var fs = require('fs');
var http = require('http');

var helper = require('../support/test-helper');

var CartodbWindshaft = require('../../lib/server');
var serverOptions = require('../../lib/server-options');

var LayergroupToken = require('../../lib/models/layergroup-token');

describe('template_api', function () {
    var server;

    before(function () {
        server = new CartodbWindshaft(serverOptions);
        server.setMaxListeners(0);
        // FIXME: we need a better way to reset cache while running tests
        server.layergroupAffectedTablesCache.cache.reset();
    });

    var httpRendererResourcesServer;
    before(function (done) {
        // Start a server to test external resources
        httpRendererResourcesServer = http.createServer(function (request, response) {
            var filename = path.join(__dirname, '/../fixtures/http/light_nolabels-1-0-0.png');
            fs.readFile(filename, { encoding: 'binary' }, function (err, file) {
                if (err) {
                    return done();
                }
                response.writeHead(200);
                response.write(file, 'binary');
                response.end();
            });
        });
        httpRendererResourcesServer.listen(8033, done);
    });

    after(function (done) {
        httpRendererResourcesServer.close(done);
    });

    var keysToDelete;
    beforeEach(function () {
        keysToDelete = {};
    });

    afterEach(function (done) {
        helper.deleteRedisKeys(keysToDelete, done);
    });

    var templateAcceptance1 = {
        version: '0.0.1',
        name: 'acceptance1',
        auth: { method: 'open' },
        layergroup: {
            version: '1.0.0',
            layers: [
                {
                    options: {
                        sql: 'select cartodb_id, ST_Translate(the_geom_webmercator, -5e6, 0) as the_geom_webmercator' +
                     ' from test_table limit 2 offset 2',
                        cartocss: '#layer { marker-fill:blue; marker-allow-overlap:true; }',
                        cartocss_version: '2.0.2',
                        interactivity: 'cartodb_id'
                    }
                }
            ]
        }
    };

    function makeTemplate (templateName) {
        return {
            version: '0.0.1',
            name: templateName || 'acceptance1',
            auth: { method: 'open' },
            layergroup: {
                version: '1.0.0',
                layers: [
                    {
                        options: {
                            sql: 'select cartodb_id, ST_Translate(the_geom_webmercator, -5e6, 0) as the_geom_webmercator' +
                            ' from test_table limit 2 offset 2',
                            cartocss: '#layer { marker-fill:blue; marker-allow-overlap:true; }',
                            cartocss_version: '2.0.2',
                            interactivity: 'cartodb_id'
                        }
                    }
                ]
            }
        };
    }

    function extendDefaultsTemplate (template) {
        return _.extend({}, template, { auth: { method: 'open' }, placeholders: {} });
    }

    it('can add template, returning id', function (done) {
        var expectedTplId = 'acceptance1';
        var postRequest1 = {
            url: '/api/v1/map/named',
            method: 'POST',
            headers: { host: 'localhost', 'Content-Type': 'application/json' },
            data: JSON.stringify(templateAcceptance1)
        };
        step(
            function postUnauthenticated () {
                var next = this;
                assert.response(server, postRequest1, {},
                    function (res) { next(null, res); });
            },
            function postTemplate (err, res) {
                assert.ifError(err);
                assert.strictEqual(res.statusCode, 403);
                var parsed = JSON.parse(res.body);
                assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'errors'), res.body);
                err = parsed.errors[0];
                assert.ok(err.match(/only.*authenticated.*user/i),
                    'Unexpected error response: ' + err);
                postRequest1.url += '?api_key=1234';
                var next = this;
                assert.response(server, postRequest1, {},
                    function (res) { next(null, res); });
            },
            function rePostTemplate (err, res) {
                assert.ifError(err);
                assert.strictEqual(res.statusCode, 200, res.body);
                var parsedBody = JSON.parse(res.body);
                var expectedBody = { template_id: expectedTplId };
                assert.deepStrictEqual(parsedBody, expectedBody);

                keysToDelete['map_tpl|localhost'] = 0;

                var next = this;
                assert.response(server, postRequest1, {},
                    function (res) { next(null, res); });
            },
            function checkFailure (err, res) {
                assert.ifError(err);
                assert.strictEqual(res.statusCode, 400, res.body);
                var parsedBody = JSON.parse(res.body);
                assert.ok(Object.prototype.hasOwnProperty.call(parsedBody, 'errors'), res.body);
                assert.ok(parsedBody.errors[0].match(/already exists/i),
                    'Unexpected error for pre-existing template name: ' + parsedBody.errors);

                done();
            }
        );
    });

    // See https://github.com/CartoDB/Windshaft-cartodb/issues/128
    it("cannot create template with auth='token' and no valid tokens", function (done) {
        var tplId;
        step(
            function postTemplate1 () {
                // clone the valid one, and give it another name
                var brokenTemplate = JSON.parse(JSON.stringify(templateAcceptance1));
                brokenTemplate.name = 'broken1';
                // Set auth='token' and specify no tokens
                brokenTemplate.auth.method = 'token';
                delete brokenTemplate.auth.tokens;
                var postRequest1 = {
                    url: '/api/v1/map/named?api_key=1234',
                    method: 'POST',
                    headers: { host: 'localhost', 'Content-Type': 'application/json' },
                    data: JSON.stringify(brokenTemplate)
                };
                var next = this;
                assert.response(server, postRequest1, {},
                    function (res) { next(null, res); });
            },
            function checkFailure1 (err, res) {
                assert.ifError(err);
                assert.strictEqual(res.statusCode, 400, res.body);
                var parsedBody = JSON.parse(res.body);
                assert.ok(Object.prototype.hasOwnProperty.call(parsedBody, 'errors'), res.body);
                var re = /invalid.*authentication.*missing/i;
                assert.ok(parsedBody.errors[0].match(re),
                    'Error for invalid authentication does not match ' + re + ': ' + parsedBody.errors);
                return null;
            },
            function postTemplate2 (err) {
                assert.ifError(err);
                // clone the valid one and rename it
                var brokenTemplate = JSON.parse(JSON.stringify(templateAcceptance1));
                brokenTemplate.name = 'broken1';
                // Set auth='token' and specify no tokens
                brokenTemplate.auth.method = 'token';
                brokenTemplate.auth.tokens = [];
                var postRequest1 = {
                    url: '/api/v1/map/named?api_key=1234',
                    method: 'POST',
                    headers: { host: 'localhost', 'Content-Type': 'application/json' },
                    data: JSON.stringify(brokenTemplate)
                };
                var next = this;
                assert.response(server, postRequest1, {},
                    function (res) { next(null, res); });
            },
            function checkFailure2 (err, res) {
                assert.ifError(err);
                assert.strictEqual(res.statusCode, 400, res.body);
                var parsedBody = JSON.parse(res.body);
                assert.ok(Object.prototype.hasOwnProperty.call(parsedBody, 'errors'), res.body);
                var re = new RegExp(/invalid.*authentication.*missing/i);
                assert.ok(parsedBody.errors[0].match(re),
                    'Error for invalid authentication does not match ' + re + ': ' + parsedBody.errors);
                return null;
            },
            function postTemplateValid (err) {
                assert.ifError(err);
                // clone the valid one and rename it
                var brokenTemplate = JSON.parse(JSON.stringify(templateAcceptance1));
                brokenTemplate.name = 'broken1';
                var postRequest1 = {
                    url: '/api/v1/map/named?api_key=1234',
                    method: 'POST',
                    headers: { host: 'localhost', 'Content-Type': 'application/json' },
                    data: JSON.stringify(brokenTemplate)
                };
                var next = this;
                assert.response(server, postRequest1, {},
                    function (res) { next(null, res); });
            },
            function putTemplateInvalid (err, res) {
                assert.ifError(err);
                assert.strictEqual(res.statusCode, 200, res.body);
                var parsed = JSON.parse(res.body);
                assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'template_id'),
                    "Missing 'template_id' from response body: " + res.body);
                tplId = parsed.template_id;
                // clone the valid one and rename it
                var brokenTemplate = JSON.parse(JSON.stringify(templateAcceptance1));
                brokenTemplate.name = 'broken1';
                // Set auth='token' and specify no tokens
                brokenTemplate.auth.method = 'token';
                brokenTemplate.auth.tokens = [];
                var putRequest1 = {
                    url: '/api/v1/map/named/' + tplId + '/?api_key=1234',
                    method: 'PUT',
                    headers: { host: 'localhost', 'Content-Type': 'application/json' },
                    data: JSON.stringify(brokenTemplate)
                };
                var next = this;
                assert.response(server, putRequest1, {},
                    function (res) { next(null, res); });
            },
            function deleteTemplate (err, res) {
                assert.ifError(err);
                assert.strictEqual(res.statusCode, 400, res.statusCode + ': ' + res.body);
                var parsed = JSON.parse(res.body);
                assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'errors'),
                    "Missing 'errors' from response body: " + res.body);
                var re = /invalid.*authentication.*missing/i;
                assert.ok(parsed.errors[0].match(re),
                    'Error for invalid authentication on PUT does not match ' +
            re + ': ' + parsed.errors);
                var delRequest = {
                    url: '/api/v1/map/named/' + tplId + '?api_key=1234',
                    method: 'DELETE',
                    headers: { host: 'localhost' }
                };
                var next = this;
                assert.response(server, delRequest, {},
                    function (res, err) { next(err, res); });
            },
            function checkDelete (err, res) {
                assert.ifError(err);
                assert.strictEqual(res.statusCode, 204, res.statusCode + ': ' + res.body);
                assert.ok(!res.body, 'Unexpected body in DELETE /template response');

                done();
            }
        );
    });

    it('instance endpoint should return CORS headers', function (done) {
        step(function postTemplate1 () {
            var next = this;
            var postRequest = {
                url: '/api/v1/map/named?api_key=1234',
                method: 'POST',
                headers: { host: 'localhost.localhost', 'Content-Type': 'application/json' },
                data: JSON.stringify(templateAcceptance1)
            };
            assert.response(server, postRequest, {}, function (res) { next(null, res); });
        },
        function testCORS () {
            const allowHeaders = 'X-Requested-With, X-Prototype-Version, X-CSRF-Token, Authorization, Content-Type';
            assert.response(server, {
                url: '/api/v1/map/named/acceptance1',
                method: 'OPTIONS'
            }, {
                status: 200,
                headers: {
                    'Access-Control-Allow-Headers': allowHeaders,
                    'Access-Control-Allow-Origin': '*'
                }
            }, function () { done(); });
        });
    });

    describe('server-metadata', function () {
        var serverMetadata;
        beforeEach(function () {
            serverMetadata = global.environment.serverMetadata;
            global.environment.serverMetadata = { cdn_url: { http: 'test', https: 'tests' } };
        });

        afterEach(function () {
            global.environment.serverMetadata = serverMetadata;
        });

        it('instance endpoint should return server metadata', function (done) {
            var tmpl = _.clone(templateAcceptance1);
            tmpl.name = 'rambotemplate2';

            step(function postTemplate1 () {
                var next = this;
                var postRequest = {
                    url: '/api/v1/map/named?api_key=1234',
                    method: 'POST',
                    headers: { host: 'localhost', 'Content-Type': 'application/json' },
                    data: JSON.stringify(tmpl)
                };
                assert.response(server, postRequest, {}, function (res) {
                    next(null, res);
                });
            },
            function testCORS () {
                var next = this;
                assert.response(server, {
                    url: '/api/v1/map/named/' + tmpl.name,
                    method: 'POST',
                    headers: { host: 'localhost', 'Content-Type': 'application/json' }
                }, {
                    status: 200
                }, function (res) {
                    var parsed = JSON.parse(res.body);
                    keysToDelete['map_cfg|' + LayergroupToken.parse(parsed.layergroupid).token] = 0;
                    keysToDelete['user:localhost:mapviews:global'] = 5;
                    assert.ok(_.isEqual(parsed.cdn_url, global.environment.serverMetadata.cdn_url));
                    next(null);
                });
            },
            function deleteTemplate (err) {
                assert.ifError(err);
                var delRequest = {
                    url: '/api/v1/map/named/' + tmpl.name + '?api_key=1234',
                    method: 'DELETE',
                    headers: { host: 'localhost', 'Content-Type': 'application/json' }
                };
                assert.response(server, delRequest, {}, function () {
                    done();
                });
            }
            );
        });
    });

    it('can list templates', function (done) {
        var tplid1, tplid2;
        step(
            function postTemplate1 () {
                var next = this;
                var postRequest = {
                    url: '/api/v1/map/named?api_key=1234',
                    method: 'POST',
                    headers: { host: 'localhost', 'Content-Type': 'application/json' },
                    data: JSON.stringify(templateAcceptance1)
                };
                assert.response(server, postRequest, {},
                    function (res) { next(null, res); });
            },
            function postTemplate2 (err, res) {
                assert.ifError(err);
                assert.strictEqual(res.statusCode, 200, res.body);
                var parsed = JSON.parse(res.body);
                assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'template_id'),
                    "Missing 'template_id' from response body: " + res.body);
                tplid1 = parsed.template_id;

                var next = this;
                var backupName = templateAcceptance1.name;
                templateAcceptance1.name += '_new';
                var postRequest = {
                    url: '/api/v1/map/named?api_key=1234',
                    method: 'POST',
                    headers: { host: 'localhost', 'Content-Type': 'application/json' },
                    data: JSON.stringify(templateAcceptance1)
                };
                templateAcceptance1.name = backupName;
                assert.response(server, postRequest, {},
                    function (res) { next(null, res); });
            },
            function litsTemplatesUnauthenticated (err, res) {
                assert.ifError(err);
                assert.strictEqual(res.statusCode, 200, res.body);
                var parsed = JSON.parse(res.body);
                assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'template_id'),
                    "Missing 'template_id' from response body: " + res.body);
                tplid2 = parsed.template_id;
                var next = this;
                var getRequest = {
                    url: '/api/v1/map/named',
                    method: 'GET',
                    headers: { host: 'localhost' }
                };
                assert.response(server, getRequest, {},
                    function (res) { next(null, res); });
            },
            function litsTemplates (err, res) {
                assert.ifError(err);
                assert.strictEqual(res.statusCode, 403, res.statusCode + ': ' + res.body);
                var parsed = JSON.parse(res.body);
                assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'errors'),
                    'Missing error from response: ' + res.body);
                err = parsed.errors[0];
                assert.ok(err.match(/authenticated user/), err);
                var next = this;
                var getRequest = {
                    url: '/api/v1/map/named?api_key=1234',
                    method: 'GET',
                    headers: { host: 'localhost' }
                };
                assert.response(server, getRequest, {},
                    function (res) { next(null, res); });
            },
            function checkList (err, res) {
                assert.ifError(err);
                assert.strictEqual(res.statusCode, 200, res.body);
                var parsed = JSON.parse(res.body);
                assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'template_ids'),
                    "Missing 'template_ids' from response body: " + res.body);
                var ids = parsed.template_ids;
                assert.strictEqual(ids.length, 2);
                assert.ok(ids.indexOf(tplid1) !== -1,
                    'Missing "' + tplid1 + "' from list response: " + ids.join(','));
                assert.ok(ids.indexOf(tplid2) !== -1,
                    'Missing "' + tplid2 + "' from list response: " + ids.join(','));

                keysToDelete['map_tpl|localhost'] = 0;

                done();
            }
        );
    });

    it('can update template', function (done) {
        var tplId;
        step(
            function postTemplate () {
                var next = this;
                var postRequest = {
                    url: '/api/v1/map/named?api_key=1234',
                    method: 'POST',
                    headers: { host: 'localhost', 'Content-Type': 'application/json' },
                    data: JSON.stringify(makeTemplate())
                };
                assert.response(server, postRequest, {},
                    function (res) { next(null, res); });
            },
            function putMisnamedTemplate (err, res) {
                assert.ifError(err);
                assert.strictEqual(res.statusCode, 200, res.body);
                var parsed = JSON.parse(res.body);
                assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'template_id'),
                    "Missing 'template_id' from response body: " + res.body);
                tplId = parsed.template_id;
                var backupName = templateAcceptance1.name;
                templateAcceptance1.name = 'changed_name';
                var putRequest = {
                    url: '/api/v1/map/named/' + tplId + '/?api_key=1234',
                    method: 'PUT',
                    headers: { host: 'localhost', 'Content-Type': 'application/json' },
                    data: JSON.stringify(templateAcceptance1)
                };
                templateAcceptance1.name = backupName;
                var next = this;
                assert.response(server, putRequest, {},
                    function (res) { next(null, res); });
            },
            function putUnexistentTemplate (err, res) {
                assert.ifError(err);
                assert.strictEqual(res.statusCode, 400, res.statusCode + ': ' + res.body);
                var parsedBody = JSON.parse(res.body);
                assert.ok(Object.prototype.hasOwnProperty.call(parsedBody, 'errors'), res.body);
                assert.ok(parsedBody.errors[0].match(/cannot update name/i),
                    'Unexpected error for invalid update: ' + parsedBody.errors);
                var putRequest = {
                    url: '/api/v1/map/named/unexistent/?api_key=1234',
                    method: 'PUT',
                    headers: { host: 'localhost', 'Content-Type': 'application/json' },
                    data: JSON.stringify(makeTemplate())
                };
                var next = this;
                assert.response(server, putRequest, {},
                    function (res) { next(null, res); });
            },
            function putValidTemplate (err, res) {
                assert.ifError(err);
                assert.strictEqual(res.statusCode, 400, res.statusCode + ': ' + res.body);
                var parsedBody = JSON.parse(res.body);
                assert.ok(Object.prototype.hasOwnProperty.call(parsedBody, 'errors'), res.body);
                assert.ok(parsedBody.errors[0].match(/cannot update name/i),
                    'Unexpected error for invalid update: ' + parsedBody.errors);
                var putRequest = {
                    url: '/api/v1/map/named/' + tplId + '/?api_key=1234',
                    method: 'PUT',
                    headers: { host: 'localhost', 'Content-Type': 'application/json' },
                    data: JSON.stringify(makeTemplate())
                };
                var next = this;
                assert.response(server, putRequest, {},
                    function (res) { next(null, res); });
            },
            function checkValidUpate (err, res) {
                assert.ifError(err);
                assert.strictEqual(res.statusCode, 200, res.statusCode + ': ' + res.body);
                var parsed = JSON.parse(res.body);
                assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'template_id'),
                    "Missing 'template_id' from response body: " + res.body);
                assert.strictEqual(tplId, parsed.template_id);

                keysToDelete['map_tpl|localhost'] = 0;

                done();
            }
        );
    });

    it('can get a template by id', function (done) {
        var tplId;
        step(
            function postTemplate () {
                var next = this;
                var postRequest = {
                    url: '/api/v1/map/named?api_key=1234',
                    method: 'POST',
                    headers: { host: 'localhost', 'Content-Type': 'application/json' },
                    data: JSON.stringify(makeTemplate())
                };
                assert.response(server, postRequest, {},
                    function (res) { next(null, res); });
            },
            function getTemplateUnauthorized (err, res) {
                assert.ifError(err);
                assert.strictEqual(res.statusCode, 200, res.body);
                var parsed = JSON.parse(res.body);
                assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'template_id'),
                    "Missing 'template_id' from response body: " + res.body);
                tplId = parsed.template_id;
                var getRequest = {
                    url: '/api/v1/map/named/' + tplId,
                    method: 'GET',
                    headers: { host: 'localhost' }
                };
                var next = this;
                assert.response(server, getRequest, {},
                    function (res) { next(null, res); });
            },
            function getTemplate (err, res) {
                assert.ifError(err);
                assert.strictEqual(res.statusCode, 403, res.statusCode + ': ' + res.body);
                var parsedBody = JSON.parse(res.body);
                assert.ok(Object.prototype.hasOwnProperty.call(parsedBody, 'errors'), res.body);
                assert.ok(parsedBody.errors[0].match(/only.*authenticated.*user/i),
                    'Unexpected error for unauthenticated template get: ' + parsedBody.errors);
                var getRequest = {
                    url: '/api/v1/map/named/' + tplId + '?api_key=1234',
                    method: 'GET',
                    headers: { host: 'localhost' }
                };
                var next = this;
                assert.response(server, getRequest, {},
                    function (res) { next(null, res); });
            },
            function checkReturnTemplate (err, res) {
                assert.ifError(err);
                assert.strictEqual(res.statusCode, 200, res.statusCode + ': ' + res.body);
                var parsed = JSON.parse(res.body);
                assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'template'),
                    "Missing 'template' from response body: " + res.body);
                assert.deepStrictEqual(extendDefaultsTemplate(makeTemplate()), parsed.template);

                keysToDelete['map_tpl|localhost'] = 0;

                done();
            }
        );
    });

    it('can delete a template by id', function (done) {
        var tplId;
        step(
            function postTemplate () {
                var next = this;
                var postRequest = {
                    url: '/api/v1/map/named?api_key=1234',
                    method: 'POST',
                    headers: { host: 'localhost', 'Content-Type': 'application/json' },
                    data: JSON.stringify(makeTemplate())
                };
                assert.response(server, postRequest, {},
                    function (res) { next(null, res); });
            },
            function getTemplate (err, res) {
                assert.ifError(err);
                assert.strictEqual(res.statusCode, 200, res.body);
                var parsed = JSON.parse(res.body);
                assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'template_id'),
                    "Missing 'template_id' from response body: " + res.body);
                tplId = parsed.template_id;
                var getRequest = {
                    url: '/api/v1/map/named/' + tplId + '?api_key=1234',
                    method: 'GET',
                    headers: { host: 'localhost' }
                };
                var next = this;
                assert.response(server, getRequest, {},
                    function (res) { next(null, res); });
            },
            function deleteTemplateUnauthorized (err, res) {
                assert.ifError(err);
                assert.strictEqual(res.statusCode, 200, res.statusCode + ': ' + res.body);
                var parsed = JSON.parse(res.body);
                assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'template'),
                    "Missing 'template' from response body: " + res.body);
                assert.deepStrictEqual(extendDefaultsTemplate(makeTemplate()), parsed.template);
                var delRequest = {
                    url: '/api/v1/map/named/' + tplId,
                    method: 'DELETE',
                    headers: { host: 'localhost' }
                };
                var next = this;
                assert.response(server, delRequest, {},
                    function (res) { next(null, res); });
            },
            function deleteTemplate (err, res) {
                assert.ifError(err);
                assert.strictEqual(res.statusCode, 403, res.statusCode + ': ' + res.body);
                var parsed = JSON.parse(res.body);
                assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'errors'),
                    "Missing 'errors' from response body: " + res.body);
                assert.ok(parsed.errors[0].match(/only.*authenticated.*user/i),
                    'Unexpected error for unauthenticated template get: ' + parsed.errors);
                var delRequest = {
                    url: '/api/v1/map/named/' + tplId + '?api_key=1234',
                    method: 'DELETE',
                    headers: { host: 'localhost' }
                };
                var next = this;
                assert.response(server, delRequest, {},
                    function (res) { next(null, res); });
            },
            function getMissingTemplate (err, res) {
                assert.ifError(err);
                assert.strictEqual(res.statusCode, 204, res.statusCode + ': ' + res.body);
                assert.ok(!res.body, 'Unexpected body in DELETE /template response');
                var getRequest = {
                    url: '/api/v1/map/named/' + tplId + '?api_key=1234',
                    method: 'GET',
                    headers: { host: 'localhost' }
                };
                var next = this;
                assert.response(server, getRequest, {},
                    function (res) { next(null, res); });
            },
            function checkGetFailure (err, res) {
                assert.ifError(err);
                assert.strictEqual(res.statusCode, 404, res.statusCode + ': ' + res.body);
                var parsed = JSON.parse(res.body);
                assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'errors'),
                    "Missing 'errors' from response body: " + res.body);
                assert.ok(parsed.errors[0].match(/cannot find/i),
                    'Unexpected error for missing template: ' + parsed.errors);

                done();
            }
        );
    });

    it('can instanciate a template by id wadus', function (done) {
        // This map fetches data from a private table
        var templateAcceptance2 = {
            version: '0.0.1',
            name: 'acceptance1',
            auth: { method: 'token', valid_tokens: ['valid1', 'valid2'] },
            layergroup: {
                version: '1.0.0',
                layers: [
                    {
                        options: {
                            sql: 'select * from test_table_private_1 LIMIT 0',
                            cartocss: '#layer { marker-fill:blue; marker-allow-overlap:true; }',
                            cartocss_version: '2.0.2',
                            interactivity: 'cartodb_id'
                        }
                    }
                ]
            }
        };

        var templateParams = {};

        var tplId;
        var layergroupid;
        step(
            function postTemplate () {
                var next = this;
                var postRequest = {
                    url: '/api/v1/map/named?api_key=1234',
                    method: 'POST',
                    headers: { host: 'localhost', 'Content-Type': 'application/json' },
                    data: JSON.stringify(templateAcceptance2)
                };
                assert.response(server, postRequest, {},
                    function (res) { next(null, res); });
            },
            function instanciateNoAuth (err, res) {
                assert.ifError(err);
                assert.strictEqual(res.statusCode, 200, res.body);
                var parsed = JSON.parse(res.body);
                assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'template_id'),
                    "Missing 'template_id' from response body: " + res.body);
                tplId = parsed.template_id;
                var postRequest = {
                    url: '/api/v1/map/named/' + tplId,
                    method: 'POST',
                    headers: { host: 'localhost', 'Content-Type': 'application/json' },
                    data: JSON.stringify(templateParams)
                };
                var next = this;
                assert.response(server, postRequest, {},
                    function (res) { next(null, res); });
            },
            // See https://github.com/CartoDB/Windshaft-cartodb/issues/173
            function instanciateForeignDB (err, res) {
                assert.ifError(err);
                assert.strictEqual(res.statusCode, 403,
                    'Unexpected success instanciating template with no auth: ' + res.statusCode + ': ' + res.body);
                var parsed = JSON.parse(res.body);
                assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'errors'),
                    "Missing 'errors' from response body: " + res.body);
                assert.ok(parsed.errors[0].match(/unauthorized/i),
                    'Unexpected error for unauthorized instance : ' + parsed.errors);
                var postRequest = {
                    url: '/api/v1/map/named/' + tplId + '?auth_token=valid2',
                    method: 'POST',
                    headers: { host: 'foreign', 'Content-Type': 'application/json' },
                    data: JSON.stringify(templateParams)
                };
                var next = this;
                assert.response(server, postRequest, {},
                    function (res) { next(null, res); });
            },
            function instanciateAuth (err, res) {
                assert.ifError(err);
                assert.strictEqual(res.statusCode, 404, res.statusCode + ': ' + res.body);
                var parsed = JSON.parse(res.body);
                assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'errors'), "Missing 'errors' from response body: " + res.body);
                assert.ok(parsed.errors[0].match(/not found/i), 'Unexpected error for forbidden instance : ' + parsed.errors);
                var postRequest = {
                    url: '/api/v1/map/named/' + tplId + '?auth_token=valid2',
                    method: 'POST',
                    headers: { host: 'localhost', 'Content-Type': 'application/json' },
                    data: JSON.stringify(templateParams)
                };
                var next = this;
                assert.response(server, postRequest, {},
                    function (res) { next(null, res); });
            },
            function fetchTileNoAuth (err, res) {
                assert.ifError(err);
                assert.strictEqual(res.statusCode, 200,
                    'Instantiating template: ' + res.statusCode + ': ' + res.body);
                var parsed = JSON.parse(res.body);
                assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'layergroupid'),
                    "Missing 'layergroupid' from response body: " + res.body);
                layergroupid = parsed.layergroupid;
                assert.ok(layergroupid.match(/^localhost@/),
                    'Returned layergroupid does not start with signer name: ' + layergroupid);
                assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'last_updated'),
                    "Missing 'last_updated' from response body: " + res.body);

                keysToDelete['user:localhost:mapviews:global'] = 5;
                keysToDelete['map_cfg|' + LayergroupToken.parse(parsed.layergroupid).token] = 0;

                // TODO: check value of last_updated ?
                var getRequest = {
                    url: '/api/v1/map/' + layergroupid + ':cb0/0/0/0.png',
                    method: 'GET',
                    headers: { host: 'localhost' },
                    encoding: 'binary'
                };
                var next = this;
                assert.response(server, getRequest, {},
                    function (res) { next(null, res); });
            },
            function fetchTileAuth (err, res) {
                assert.ifError(err);
                assert.strictEqual(res.statusCode, 403,
                    'Fetching tile with no auth: ' + res.statusCode + ': ' + res.body);
                var parsed = JSON.parse(res.body);
                assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'errors'),
                    "Missing 'errors' from response body: " + res.body);
                assert.ok(parsed.errors[0].match(/permission denied/i),
                    'Unexpected error for unauthorized instance (expected /permission denied/): ' + parsed.errors);
                var getRequest = {
                    url: '/api/v1/map/' + layergroupid + '/0/0/0.png?auth_token=valid1',
                    method: 'GET',
                    headers: { host: 'localhost' },
                    encoding: 'binary'
                };
                var next = this;
                assert.response(server, getRequest, {},
                    function (res) { next(null, res); });
            },
            function checkTile (err, res) {
                assert.ifError(err);
                assert.strictEqual(res.statusCode, 200,
                    'Unexpected error for authorized instance: ' + res.statusCode + ' -- ' + res.body);
                assert.strictEqual(res.headers['content-type'], 'image/png');
                return null;
            },
            // See https://github.com/CartoDB/Windshaft-cartodb/issues/172
            function fetchTileForeignSignature (err) {
                assert.ifError(err);
                var foreignsigned = layergroupid.replace(/[^@]*@/, 'foreign@');
                var getRequest = {
                    url: '/api/v1/map/' + foreignsigned + '/0/0/0.png?auth_token=valid1',
                    method: 'GET',
                    headers: { host: 'localhost' },
                    encoding: 'binary'
                };
                var next = this;
                assert.response(server, getRequest, {},
                    function (res) { next(null, res); });
            },
            function checkForeignSignerError (err, res) {
                assert.ifError(err);
                assert.strictEqual(res.statusCode, 403,
                    'Unexpected error for authorized instance: ' + res.statusCode + ' -- ' + res.body);
                var parsed = JSON.parse(res.body);
                assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'errors'),
                    "Missing 'errors' from response body: " + res.body);
                assert.ok(parsed.errors[0].match(/cannot use/i),
                    'Unexpected error for unauthorized instance (expected /cannot use/): ' + parsed.errors);
                return null;
            },
            function deleteTemplate (err) {
                assert.ifError(err);
                var delRequest = {
                    url: '/api/v1/map/named/' + tplId + '?api_key=1234',
                    method: 'DELETE',
                    headers: { host: 'localhost' }
                };
                var next = this;
                assert.response(server, delRequest, {},
                    function (res) { next(null, res); });
            },
            function fetchTileDeleted (err, res) {
                assert.ifError(err);
                assert.strictEqual(res.statusCode, 204,
                    'Deleting template: ' + res.statusCode + ':' + res.body);
                var getRequest = {
                    url: '/api/v1/map/' + layergroupid + '/0/0/0.png?auth_token=valid1',
                    method: 'GET',
                    headers: { host: 'localhost' },
                    encoding: 'binary'
                };
                var next = this;
                assert.response(server, getRequest, {},
                    function (res) { next(null, res); });
            },
            function checkTileAvailable (err, res) {
                assert.ifError(err);
                assert.strictEqual(res.statusCode, 200, 'Tile should be accessible');
                assert.strictEqual(res.headers['content-type'], 'image/png');

                done();
            }
        );
    });

    it('can instanciate a template with torque layer by id', function (done) {
        // This map fetches data from a private table
        var template = {
            version: '0.0.1',
            name: 'acceptance1',
            auth: { method: 'token', valid_tokens: ['valid1', 'valid2'] },
            layergroup: {
                version: '1.1.0',
                layers: [
                    {
                        type: 'torque',
                        options: {
                            sql: 'select * from test_table_private_1 LIMIT 0',
                            cartocss: 'Map { -torque-frame-count:1; -torque-resolution:1; ' +
                       "-torque-aggregation-function:'count(*)'; -torque-time-attribute:'updated_at'; }"
                        }
                    }
                ]
            }
        };

        var templateParams = {};

        var tplId;
        var layergroupid;
        step(
            function postTemplate () {
                var next = this;
                var postRequest = {
                    url: '/api/v1/map/named?api_key=1234',
                    method: 'POST',
                    headers: { host: 'localhost', 'Content-Type': 'application/json' },
                    data: JSON.stringify(template)
                };
                assert.response(server, postRequest, {},
                    function (res) { next(null, res); });
            },
            function instanciateNoAuth (err, res) {
                assert.ifError(err);
                assert.strictEqual(res.statusCode, 200, res.body);
                var parsed = JSON.parse(res.body);
                assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'template_id'),
                    "Missing 'template_id' from response body: " + res.body);
                tplId = parsed.template_id;
                var postRequest = {
                    url: '/api/v1/map/named/' + tplId,
                    method: 'POST',
                    headers: { host: 'localhost', 'Content-Type': 'application/json' },
                    data: JSON.stringify(templateParams)
                };
                var next = this;
                assert.response(server, postRequest, {},
                    function (res) { next(null, res); });
            },
            function instanciateAuth (err, res) {
                assert.ifError(err);
                assert.strictEqual(res.statusCode, 403,
                    'Unexpected success instanciating template with no auth: ' + res.statusCode + ': ' + res.body);
                var parsed = JSON.parse(res.body);
                assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'errors'),
                    "Missing 'errors' from response body: " + res.body);
                assert.ok(parsed.errors[0].match(/unauthorized/i),
                    'Unexpected error for unauthorized instance : ' + parsed.errors);
                var postRequest = {
                    url: '/api/v1/map/named/' + tplId + '?auth_token=valid2',
                    method: 'POST',
                    headers: { host: 'localhost', 'Content-Type': 'application/json' },
                    data: JSON.stringify(templateParams)
                };
                var next = this;
                assert.response(server, postRequest, {},
                    function (res) { next(null, res); });
            },
            function fetchTileNoAuth (err, res) {
                assert.ifError(err);
                assert.strictEqual(res.statusCode, 200,
                    'Instantiating template: ' + res.statusCode + ': ' + res.body);
                var parsed = JSON.parse(res.body);
                assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'layergroupid'),
                    "Missing 'layergroupid' from response body: " + res.body);
                layergroupid = parsed.layergroupid;
                assert.ok(layergroupid.match(/^localhost@/),
                    'Returned layergroupid does not start with signer name: ' + layergroupid);
                assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'last_updated'),
                    "Missing 'last_updated' from response body: " + res.body);

                keysToDelete['map_cfg|' + LayergroupToken.parse(parsed.layergroupid).token] = 0;
                keysToDelete['user:localhost:mapviews:global'] = 5;

                // TODO: check value of last_updated ?
                var getRequest = {
                    url: '/api/v1/map/' + layergroupid + ':cb0/0/0/0/0.json.torque',
                    method: 'GET',
                    headers: { host: 'localhost' },
                    encoding: 'binary'
                };
                var next = this;
                assert.response(server, getRequest, {},
                    function (res) { next(null, res); });
            },
            function fetchTileAuth (err, res) {
                assert.ifError(err);
                assert.strictEqual(res.statusCode, 403,
                    'Fetching tile with no auth: ' + res.statusCode + ': ' + res.body);
                var parsed = JSON.parse(res.body);
                assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'errors'),
                    "Missing 'errors' from response body: " + res.body);
                assert.ok(parsed.errors[0].match(/permission denied/i),
                    'Unexpected error for unauthorized instance (expected /permission denied): ' + parsed.errors);
                var getRequest = {
                    url: '/api/v1/map/' + layergroupid + ':cb1/0/0/0/0.json.torque?auth_token=valid1',
                    method: 'GET',
                    headers: { host: 'localhost' },
                    encoding: 'binary'
                };
                var next = this;
                assert.response(server, getRequest, {},
                    function (res) { next(null, res); });
            },
            function checkTileFetchOnRestart (err, res) {
                assert.ifError(err);
                assert.strictEqual(res.statusCode, 200,
                    'Unexpected error for authorized instance: ' + res.statusCode + ' -- ' + res.body);
                assert.strictEqual(res.headers['content-type'], 'application/json; charset=utf-8');
                var cc = res.headers['x-cache-channel'];
                var expectedCC = 'test_windshaft_cartodb_user_1_db:public.test_table_private_1';
                assert.ok(cc);
                assert.strictEqual(cc, expectedCC);
                // hack simulating restart...
                // FIXME: we need a better way to reset cache while running tests
                server.layergroupAffectedTablesCache.cache.reset(); // need to clean channel cache
                var getRequest = {
                    url: '/api/v1/map/' + layergroupid + ':cb1/0/0/0/1.json.torque?auth_token=valid1',
                    method: 'GET',
                    headers: { host: 'localhost' },
                    encoding: 'binary'
                };
                var next = this;
                assert.response(server, getRequest, {},
                    function (res) { next(null, res); });
            },
            function checkCacheChannel (err, res) {
                assert.ifError(err);
                assert.strictEqual(res.statusCode, 200,
                    'Unexpected error for authorized instance: ' + res.statusCode + ' -- ' + res.body);
                assert.strictEqual(res.headers['content-type'], 'application/json; charset=utf-8');
                var cc = res.headers['x-cache-channel'];
                var expectedCC = 'test_windshaft_cartodb_user_1_db:public.test_table_private_1';
                assert.ok(cc, 'Missing X-Cache-Channel on fetch-after-restart');
                assert.strictEqual(cc, expectedCC);
                return null;
            },
            function deleteTemplate (err) {
                assert.ifError(err);
                var delRequest = {
                    url: '/api/v1/map/named/' + tplId + '?api_key=1234',
                    method: 'DELETE',
                    headers: { host: 'localhost' }
                };
                var next = this;
                assert.response(server, delRequest, {},
                    function (res) { next(null, res); });
            },
            function fetchTileDeleted (err, res) {
                assert.ifError(err);
                assert.strictEqual(res.statusCode, 204,
                    'Deleting template: ' + res.statusCode + ':' + res.body);
                var getRequest = {
                    url: '/api/v1/map/' + layergroupid + ':cb2/0/0/0/0.json.torque?auth_token=valid1',
                    method: 'GET',
                    headers: { host: 'localhost' },
                    encoding: 'binary'
                };
                var next = this;
                assert.response(server, getRequest, {},
                    function (res) { next(null, res); });
            },
            function checkTorqueTileAvailable (err, res) {
                assert.ifError(err);
                assert.strictEqual(res.statusCode, 200, 'Torque tile should be accessible');
                assert.strictEqual(res.headers['content-type'], 'application/json; charset=utf-8');

                done();
            }
        );
    });

    it('can instanciate a template with attribute service by id', function (done) {
        // This map fetches data from a private table
        var template = {
            version: '0.0.1',
            name: 'acceptance1',
            auth: { method: 'token', valid_tokens: ['valid1', 'valid2'] },
            layergroup: {
                version: '1.1.0',
                layers: [
                    {
                        options: {
                            sql: 'select * from test_table_private_1 where cartodb_id in ( 5,6 )',
                            cartocss: '#layer { marker-fill:blue; marker-allow-overlap:true; }',
                            cartocss_version: '2.0.2',
                            attributes: { id: 'cartodb_id', columns: ['name', 'address'] }
                        }
                    }
                ]
            }
        };

        var templateParams = {};

        var tplId;
        var layergroupid;
        step(
            function postTemplate () {
                var next = this;
                var postRequest = {
                    url: '/api/v1/map/named?api_key=1234',
                    method: 'POST',
                    headers: { host: 'localhost', 'Content-Type': 'application/json' },
                    data: JSON.stringify(template)
                };
                assert.response(server, postRequest, {},
                    function (res) { next(null, res); });
            },
            function instanciateNoAuth (err, res) {
                assert.ifError(err);
                assert.strictEqual(res.statusCode, 200, res.body);
                var parsed = JSON.parse(res.body);
                assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'template_id'),
                    "Missing 'template_id' from response body: " + res.body);
                tplId = parsed.template_id;
                var postRequest = {
                    url: '/api/v1/map/named/' + tplId,
                    method: 'POST',
                    headers: { host: 'localhost', 'Content-Type': 'application/json' },
                    data: JSON.stringify(templateParams)
                };
                var next = this;
                assert.response(server, postRequest, {},
                    function (res) { next(null, res); });
            },
            function instanciateAuth (err, res) {
                assert.ifError(err);
                assert.strictEqual(res.statusCode, 403,
                    'Unexpected success instanciating template with no auth: ' + res.statusCode + ': ' + res.body);
                var parsed = JSON.parse(res.body);
                assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'errors'),
                    "Missing 'errors' from response body: " + res.body);
                assert.ok(parsed.errors[0].match(/unauthorized/i),
                    'Unexpected error for unauthorized instance : ' + parsed.errors);
                var postRequest = {
                    url: '/api/v1/map/named/' + tplId + '?auth_token=valid2',
                    method: 'POST',
                    headers: { host: 'localhost', 'Content-Type': 'application/json' },
                    data: JSON.stringify(templateParams)
                };
                var next = this;
                assert.response(server, postRequest, {},
                    function (res) { next(null, res); });
            },
            function fetchAttributeNoAuth (err, res) {
                assert.ifError(err);
                assert.strictEqual(res.statusCode, 200,
                    'Instantiating template: ' + res.statusCode + ': ' + res.body);
                var parsed = JSON.parse(res.body);
                assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'layergroupid'),
                    "Missing 'layergroupid' from response body: " + res.body);
                layergroupid = parsed.layergroupid;
                assert.ok(layergroupid.match(/^localhost@/),
                    'Returned layergroupid does not start with signer name: ' + layergroupid);
                assert.strictEqual(res.headers['x-layergroup-id'], parsed.layergroupid);
                assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'last_updated'),
                    "Missing 'last_updated' from response body: " + res.body);

                keysToDelete['map_cfg|' + LayergroupToken.parse(parsed.layergroupid).token] = 0;
                keysToDelete['user:localhost:mapviews:global'] = 5;

                // TODO: check value of last_updated ?
                var getRequest = {
                    url: '/api/v1/map/' + layergroupid + ':cb0/0/attributes/5',
                    method: 'GET',
                    headers: { host: 'localhost' },
                    encoding: 'binary'
                };
                var next = this;
                assert.response(server, getRequest, {},
                    function (res) { next(null, res); });
            },
            function fetchAttributeAuth (err, res) {
                assert.ifError(err);
                assert.strictEqual(res.statusCode, 403,
                    'Fetching tile with no auth: ' + res.statusCode + ': ' + res.body);
                var parsed = JSON.parse(res.body);
                assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'errors'),
                    "Missing 'errors' from response body: " + res.body);
                assert.ok(parsed.errors[0].match(/permission denied/i),
                    'Unexpected error for unauthorized getAttributes (expected /permission denied/): ' + parsed.errors);
                var getRequest = {
                    url: '/api/v1/map/' + layergroupid + ':cb1/0/attributes/5?auth_token=valid2',
                    method: 'GET',
                    headers: { host: 'localhost' },
                    encoding: 'binary'
                };
                var next = this;
                assert.response(server, getRequest, {},
                    function (res) { next(null, res); });
            },
            function checkAttribute (err, res) {
                assert.ifError(err);
                assert.strictEqual(res.statusCode, 200,
                    'Unexpected error for authorized getAttributes: ' + res.statusCode + ' -- ' + res.body);
                assert.strictEqual(res.headers['content-type'], 'application/json; charset=utf-8');
                return null;
            },
            function deleteTemplate (err) {
                assert.ifError(err);
                var delRequest = {
                    url: '/api/v1/map/named/' + tplId + '?api_key=1234',
                    method: 'DELETE',
                    headers: { host: 'localhost' }
                };
                var next = this;
                assert.response(server, delRequest, {},
                    function (res) { next(null, res); });
            },
            function fetchAttrDeleted (err, res) {
                assert.ifError(err);
                assert.strictEqual(res.statusCode, 204,
                    'Deleting template: ' + res.statusCode + ':' + res.body);
                var getRequest = {
                    url: '/api/v1/map/' + layergroupid + ':cb2/0/attributes/5?auth_token=valid2',
                    method: 'GET',
                    headers: { host: 'localhost' },
                    encoding: 'binary'
                };
                var next = this;
                assert.response(server, getRequest, {},
                    function (res) { next(null, res); });
            },
            function checkLayerAttributesAvailable (err, res) {
                assert.ifError(err);
                assert.strictEqual(res.statusCode, 200, 'Layer attributes should be accessible');
                assert.strictEqual(res.headers['content-type'], 'application/json; charset=utf-8');

                done();
            }
        );
    });

    it('can instanciate a template by id with open auth', function (done) {
        // This map fetches data from a private table
        var templateAcceptanceOpen = {
            version: '0.0.1',
            name: 'acceptance_open',
            auth: { method: 'open' },
            layergroup: {
                version: '1.0.0',
                layers: [
                    {
                        options: {
                            sql: 'select * from test_table_private_1 LIMIT 0',
                            cartocss: '#layer { marker-fill:blue; marker-allow-overlap:true; }',
                            cartocss_version: '2.0.2',
                            interactivity: 'cartodb_id'
                        }
                    }
                ]
            }
        };

        var templateParams = {};

        var tplId;
        step(
            function postTemplate () {
                var next = this;
                var postRequest = {
                    url: '/api/v1/map/named?api_key=1234',
                    method: 'POST',
                    headers: { host: 'localhost', 'Content-Type': 'application/json' },
                    data: JSON.stringify(templateAcceptanceOpen)
                };
                assert.response(server, postRequest, {},
                    function (res) { next(null, res); });
            },
            function instanciateNoAuth (err, res) {
                assert.ifError(err);
                assert.strictEqual(res.statusCode, 200, res.body);
                var parsed = JSON.parse(res.body);
                assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'template_id'),
                    "Missing 'template_id' from response body: " + res.body);
                tplId = parsed.template_id;
                var postRequest = {
                    url: '/api/v1/map/named/' + tplId,
                    method: 'POST',
                    headers: { host: 'localhost', 'Content-Type': 'application/json' },
                    data: JSON.stringify(templateParams)
                };
                helper.checkNoCache(res);
                var next = this;
                assert.response(server, postRequest, {},
                    function (res) { next(null, res); });
            },
            function instanciateAuth (err, res) {
                assert.ifError(err);
                assert.strictEqual(res.statusCode, 200,
                    'Unexpected success instanciating template with no auth: ' + res.statusCode + ': ' + res.body);

                keysToDelete['map_cfg|' + LayergroupToken.parse(JSON.parse(res.body).layergroupid).token] = 0;
                keysToDelete['map_tpl|localhost'] = 0;
                keysToDelete['user:localhost:mapviews:global'] = 5;

                done();
            }
        );
    });

    it('can instanciate a template using jsonp', function (done) {
        // This map fetches data from a private table
        var templateAcceptanceOpen = {
            version: '0.0.1',
            name: 'acceptance_open_jsonp',
            auth: { method: 'open' },
            layergroup: {
                version: '1.0.0',
                layers: [
                    {
                        options: {
                            sql: 'select * from test_table_private_1 LIMIT 0',
                            cartocss: '#layer { marker-fill:blue; marker-allow-overlap:true; }',
                            cartocss_version: '2.0.2',
                            interactivity: 'cartodb_id'
                        }
                    }
                ]
            }
        };

        var tplId;
        step(
            function postTemplate () {
                var next = this;
                var postRequest = {
                    url: '/api/v1/map/named?api_key=1234',
                    method: 'POST',
                    headers: { host: 'localhost', 'Content-Type': 'application/json' },
                    data: JSON.stringify(templateAcceptanceOpen)
                };
                assert.response(server, postRequest, {},
                    function (res) { next(null, res); });
            },
            function instanciateNoAuth (err, res) {
                assert.ifError(err);
                assert.strictEqual(res.statusCode, 200, res.body);
                var parsed = JSON.parse(res.body);
                assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'template_id'),
                    "Missing 'template_id' from response body: " + res.body);
                tplId = parsed.template_id;
                var postRequest = {
                    url: '/api/v1/map/named/' + tplId + '/jsonp?callback=jsonTest',
                    method: 'GET',
                    headers: { host: 'localhost' }
                };
                var next = this;
                assert.response(server, postRequest, {},
                    function (res) { next(null, res); });
            },
            function checkInstanciation (err, res) {
                assert.ifError(err);
                assert.strictEqual(res.statusCode, 200, res.statusCode + ': ' + res.body);
                // See https://github.com/CartoDB/Windshaft-cartodb/issues/176
                helper.checkCache(res);
                var expectedSurrogateKey = [
                    new QueryTables.QueryMetadata([{
                        dbname: 'test_windshaft_cartodb_user_1_db',
                        schema_name: 'public',
                        table_name: 'test_table_private_1'
                    }]).key(),
                    new NamedMapsCacheEntry('localhost', templateAcceptanceOpen.name).key()
                ].join(' ');
                helper.checkSurrogateKey(res, expectedSurrogateKey);

                /* eslint-disable no-unused-vars, no-eval */
                function jsonTest (body) {
                    keysToDelete['map_cfg|' + LayergroupToken.parse(body.layergroupid).token] = 0;
                }
                eval(res.body);
                /* eslint-enable */

                keysToDelete['map_tpl|localhost'] = 0;
                keysToDelete['user:localhost:mapviews:global'] = 5;

                return null;
            },
            function finish (err) {
                done(err);
            }
        );
    });

    it('can instanciate a template using jsonp with params', function (done) {
        // This map fetches data from a private table
        var templateAcceptanceOpen = {
            version: '0.0.1',
            name: 'acceptance_open_jsonp_params',
            auth: { method: 'open' },
            placeholders: {
                color: { type: 'css_color', default: 'red' }
            },
            layergroup: {
                version: '1.0.0',
                layers: [
                    {
                        options: {
                            sql: 'select * from test_table_private_1 LIMIT 0',
                            cartocss: '#layer { marker-fill: <%= color %>; marker-allow-overlap:true; }',
                            cartocss_version: '2.0.2',
                            interactivity: 'cartodb_id'
                        }
                    }
                ]
            }
        };

        var tplId;
        step(
            function postTemplate () {
                var next = this;
                var postRequest = {
                    url: '/api/v1/map/named?api_key=1234',
                    method: 'POST',
                    headers: { host: 'localhost', 'Content-Type': 'application/json' },
                    data: JSON.stringify(templateAcceptanceOpen)
                };
                assert.response(server, postRequest, {},
                    function (res) { next(null, res); });
            },
            function instanciateNoAuth (err, res) {
                assert.ifError(err);
                assert.strictEqual(res.statusCode, 200, res.body);
                var parsed = JSON.parse(res.body);
                assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'template_id'),
                    "Missing 'template_id' from response body: " + res.body);
                tplId = parsed.template_id;
                var postRequest = {
                    url: '/api/v1/map/named/' + tplId + '/jsonp?callback=jsonTest&config=' + JSON.stringify({ color: 'blue' }),
                    method: 'GET',
                    headers: { host: 'localhost' }
                };
                var next = this;
                assert.response(server, postRequest, {},
                    function (res) { next(null, res); });
            },
            function checkInstanciation (err, res) {
                assert.ifError(err);
                assert.strictEqual(res.statusCode, 200, res.statusCode + ': ' + res.body);
                // See https://github.com/CartoDB/Windshaft-cartodb/issues/176
                helper.checkCache(res);
                var expectedSurrogateKey = [
                    new QueryTables.QueryMetadata([{
                        dbname: 'test_windshaft_cartodb_user_1_db',
                        schema_name: 'public',
                        table_name: 'test_table_private_1'
                    }]).key(),
                    new NamedMapsCacheEntry('localhost', templateAcceptanceOpen.name).key()
                ].join(' ');
                helper.checkSurrogateKey(res, expectedSurrogateKey);

                /* eslint-disable no-unused-vars, no-eval */
                function jsonTest (body) {
                    keysToDelete['map_cfg|' + LayergroupToken.parse(body.layergroupid).token] = 0;
                }
                eval(res.body);
                /* eslint-enable */

                keysToDelete['map_tpl|localhost'] = 0;
                keysToDelete['user:localhost:mapviews:global'] = 5;

                done();
            }
        );
    });

    it('template instantiation raises mapviews counter', function (done) {
        var layergroup = {
            stat_tag: 'random_tag',
            version: '1.0.0',
            layers: [
                {
                    options: {
                        sql: 'select 1 as cartodb_id, !pixel_height! as h,' +
                   ' ST_Buffer(!bbox!, -32*greatest(!pixel_width!,!pixel_height!)) as the_geom_webmercator',
                        cartocss: '#layer { polygon-fill:red; }',
                        cartocss_version: '2.0.1'
                    }
                }
            ]
        };
        var template = {
            version: '0.0.1',
            name: 'stat_gathering',
            auth: { method: 'open' },
            layergroup: layergroup
        };
        var statskey = 'user:localhost:mapviews';
        var redisStatsClient = redis.createClient(global.environment.redis.port);
        var templateId; // will be set on template post
        var now = strftime('%Y%m%d', new Date());
        var errors = [];
        step(
            function cleanStats () {
                var next = this;
                redisStatsClient.select(redisStatsDb, function (err) {
                    if (err) {
                        next(err);
                    } else {
                        redisStatsClient.del(statskey + ':global', next);
                    }
                });
            },
            function doPostTempate (err) {
                assert.ifError(err);
                var postRequest = {
                    url: '/api/v1/map/named?api_key=1234',
                    method: 'POST',
                    headers: { host: 'localhost', 'Content-Type': 'application/json' },
                    data: JSON.stringify(template)
                };
                var next = this;
                assert.response(server, postRequest, {},
                    function (res) { next(null, res); });
            },
            function instantiateTemplate (err, res) {
                assert.ifError(err);
                assert.strictEqual(res.statusCode, 200, res.body);
                templateId = JSON.parse(res.body).template_id;
                var postRequest = {
                    url: '/api/v1/map/named/' + templateId,
                    method: 'POST',
                    headers: { host: 'localhost', 'Content-Type': 'application/json' },
                    data: JSON.stringify({})
                };
                var next = this;
                assert.response(server, postRequest, {},
                    function (res) { next(null, res); });
            },
            function checkGlobalStats (err, res) {
                assert.ifError(err);
                assert.strictEqual(res.statusCode, 200,
                    'Instantiating template: ' + res.statusCode + ': ' + res.body);
                var parsed = JSON.parse(res.body);
                assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'layergroupid'),
                    "Missing 'layergroupid' from response body: " + res.body);
                keysToDelete['map_cfg|' + LayergroupToken.parse(parsed.layergroupid).token] = 0;
                redisStatsClient.ZSCORE(statskey + ':global', now, this);
            },
            function checkTagStats (err, val) {
                assert.ifError(err);
                assert.strictEqual(val, '1', 'Expected score of ' + now + ' in ' + statskey + ':global to be 1, got ' + val);
                redisStatsClient.ZSCORE(statskey + ':stat_tag:random_tag', now, this);
            },
            function checkTagStatsValue (err, val) {
                assert.ifError(err);
                assert.equal(val, '1', 'Expected score of ' + now + ' in ' + statskey + ':stat_tag:' + layergroup.stat_tag +
              ' to be 1, got ' + val);
                return null;
            },
            function deleteTemplate (err) {
                assert.ifError(err);
                var delRequest = {
                    url: '/api/v1/map/named/' + templateId + '?api_key=1234',
                    method: 'DELETE',
                    headers: { host: 'localhost' }
                };
                var next = this;
                assert.response(server, delRequest, {},
                    function (res) { next(null, res); });
            },
            function cleanupStats (err, res) {
                if (err) {
                    return done(err);
                }
                assert.strictEqual(res.statusCode, 204, res.statusCode + ': ' + res.body);
                if (err) {
                    errors.push('' + err);
                }

                keysToDelete['user:localhost:mapviews:global'] = 5;
                keysToDelete[statskey + ':stat_tag:' + layergroup.stat_tag] = 5;

                done();
            }
        );
    });

    it('instance map token changes with templates certificate changes', function (done) {
        // This map fetches data from a private table
        var templateAcceptance2 = {
            version: '0.0.1',
            name: 'acceptance2',
            auth: { method: 'token', valid_tokens: ['valid1', 'valid2'] },
            layergroup: {
                version: '1.0.0',
                layers: [
                    {
                        options: {
                            sql: 'select * from test_table_private_1 LIMIT 0',
                            cartocss: '#layer { marker-fill:blue; marker-allow-overlap:true; }',
                            cartocss_version: '2.0.2',
                            interactivity: 'cartodb_id'
                        }
                    }
                ]
            }
        };

        var templateParams = {};

        var tplId;
        var layergroupid;
        step(
            function postTemplate () {
                var next = this;
                var postRequest = {
                    url: '/api/v1/map/named?api_key=1234',
                    method: 'POST',
                    headers: { host: 'localhost', 'Content-Type': 'application/json' },
                    data: JSON.stringify(templateAcceptance2)
                };
                assert.response(server, postRequest, {},
                    function (res) { next(null, res); });
            },
            function instance1 (err, res) {
                assert.ifError(err);
                assert.strictEqual(res.statusCode, 200, res.body);
                var parsed = JSON.parse(res.body);
                assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'template_id'),
                    "Missing 'template_id' from response body: " + res.body);
                tplId = parsed.template_id;
                var postRequest = {
                    url: '/api/v1/map/named/' + tplId + '?auth_token=valid2',
                    method: 'POST',
                    headers: { host: 'localhost', 'Content-Type': 'application/json' },
                    data: JSON.stringify(templateParams)
                };
                var next = this;
                assert.response(server, postRequest, {},
                    function (res, err) { next(err, res); });
            },
            function checkInstance1 (err, res) {
                assert.ifError(err);
                assert.strictEqual(res.statusCode, 200,
                    'Instantiating template: ' + res.statusCode + ': ' + res.body);
                var parsed = JSON.parse(res.body);
                assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'layergroupid'),
                    "Missing 'layergroupid' from response body: " + res.body);
                layergroupid = parsed.layergroupid;
                helper.checkSurrogateKey(res, new NamedMapsCacheEntry('localhost', templateAcceptance2.name).key());

                keysToDelete['map_cfg|' + LayergroupToken.parse(parsed.layergroupid).token] = 0;
                return null;
            },
            function updateTemplate (err) {
                assert.ifError(err);
                // clone the valid one and rename it
                var changedTemplate = JSON.parse(JSON.stringify(templateAcceptance2));
                changedTemplate.auth.method = 'open';
                var postRequest = {
                    url: '/api/v1/map/named/' + tplId + '/?api_key=1234',
                    method: 'PUT',
                    headers: { host: 'localhost', 'Content-Type': 'application/json' },
                    data: JSON.stringify(changedTemplate)
                };
                var next = this;
                assert.response(server, postRequest, {},
                    function (res) { next(null, res); });
            },
            function instance2 (err, res) {
                assert.ifError(err);
                assert.strictEqual(res.statusCode, 200, res.body);
                var parsed = JSON.parse(res.body);
                assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'template_id'),
                    "Missing 'template_id' from response body: " + res.body);
                assert.strictEqual(tplId, parsed.template_id);
                var postRequest = {
                    url: '/api/v1/map/named/' + tplId + '?auth_token=valid2',
                    method: 'POST',
                    headers: { host: 'localhost', 'Content-Type': 'application/json' },
                    data: JSON.stringify(templateParams)
                };
                var next = this;
                assert.response(server, postRequest, {},
                    function (res, err) { next(err, res); });
            },
            function checkInstance2 (err, res) {
                assert.ifError(err);
                assert.strictEqual(res.statusCode, 200,
                    'Instantiating template: ' + res.statusCode + ': ' + res.body);
                var parsed = JSON.parse(res.body);
                assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'layergroupid'),
                    "Missing 'layergroupid' from response body: " + res.body);
                assert.ok(layergroupid !== parsed.layergroupid);
                helper.checkSurrogateKey(res, new NamedMapsCacheEntry('localhost', templateAcceptance2.name).key());

                keysToDelete['map_tpl|localhost'] = 0;
                keysToDelete['map_cfg|' + LayergroupToken.parse(parsed.layergroupid).token] = 0;
                keysToDelete['user:localhost:mapviews:global'] = 5;

                done();
            }
        );
    });

    it('can use an http layer', function (done) {
        var username = 'localhost';

        var httpTemplateName = 'acceptance_http';
        var httpTemplate = {
            version: '0.0.1',
            name: httpTemplateName,
            layergroup: {
                version: '1.3.0',
                layers: [
                    {
                        type: 'http',
                        options: {
                            urlTemplate: 'http://127.0.0.1:8033/{s}/{z}/{x}/{y}.png',
                            subdomains: [
                                'a',
                                'b',
                                'c'
                            ]
                        }
                    },
                    {
                        type: 'cartodb',
                        options: {
                            sql: 'select * from test_table_private_1',
                            cartocss: '#layer { marker-fill:blue; }',
                            cartocss_version: '2.0.2',
                            interactivity: 'cartodb_id'
                        }
                    }
                ]
            }
        };

        var templateParams = {};

        var expectedTemplateId = httpTemplateName;
        var layergroupid;
        step(
            function createTemplate () {
                var next = this;
                assert.response(
                    server,
                    {
                        url: '/api/v1/map/named?api_key=1234',
                        method: 'POST',
                        headers: {
                            host: username,
                            'Content-Type': 'application/json'
                        },
                        data: JSON.stringify(httpTemplate)
                    },
                    {
                        status: 200
                    },
                    function (res, err) {
                        next(err, res);
                    }
                );
            },
            function instantiateTemplate (err, res) {
                if (err) {
                    throw err;
                }
                assert.deepStrictEqual(JSON.parse(res.body), { template_id: expectedTemplateId });
                var next = this;
                assert.response(
                    server,
                    {
                        url: '/api/v1/map/named/' + expectedTemplateId,
                        method: 'POST',
                        headers: {
                            host: username,
                            'Content-Type': 'application/json'
                        },
                        data: JSON.stringify(templateParams)
                    },
                    {
                        status: 200
                    },
                    function (res) {
                        next(null, res);
                    }
                );
            },
            function fetchTile (err, res) {
                if (err) {
                    throw err;
                }

                var parsed = JSON.parse(res.body);
                assert.ok(
                    Object.prototype.hasOwnProperty.call(parsed, 'layergroupid'), "Missing 'layergroupid' from response body: " + res.body);
                layergroupid = parsed.layergroupid;

                keysToDelete['map_cfg|' + LayergroupToken.parse(parsed.layergroupid).token] = 0;
                keysToDelete['user:localhost:mapviews:global'] = 5;

                var next = this;
                assert.response(
                    server,
                    {
                        url: '/api/v1/map/' + layergroupid + '/all/0/0/0.png',
                        method: 'GET',
                        headers: {
                            host: username
                        },
                        encoding: 'binary'
                    },
                    {
                        status: 200
                    },
                    function (res) {
                        next(null, res);
                    }
                );
            },
            function checkTile (err, res) {
                if (err) {
                    throw err;
                }
                assert.strictEqual(res.headers['content-type'], 'image/png');
                return null;
            },
            function deleteTemplate (err) {
                if (err) {
                    throw err;
                }
                var next = this;
                assert.response(
                    server,
                    {
                        url: '/api/v1/map/named/' + expectedTemplateId + '?api_key=1234',
                        method: 'DELETE',
                        headers: {
                            host: username
                        }
                    },
                    {
                        status: 204
                    },
                    function (res, err) {
                        next(err, res);
                    }
                );
            },
            function finish (err) {
                done(err);
            }
        );
    });

    describe('named map nonexistent tokens', function () {
        var username = 'localhost';
        var templateHash = 'deadbeef';
        var nonexistentToken = 'wadus';

        function request (token) {
            return {
                url: '/api/v1/map/' + token + '/all/0/0/0.png',
                method: 'GET',
                headers: {
                    host: username
                },
                encoding: 'binary'
            };
        }

        var expectedResponse = {
            headers: {
                'Content-Type': 'application/json; charset=utf-8'
            },
            status: 400
        };

        function checkTileFn (done) {
            return function checkTile (res, err) {
                if (err) {
                    return done(err);
                }
                assert.deepStrictEqual(JSON.parse(res.body).errors,
                    ["Invalid or nonexistent map configuration token '" + nonexistentToken + "'"]);

                done();
            };
        }

        it('returns an error for named map nonexistent tokens', function (done) {
            var nonexistentNamedMapToken = username + '@' + templateHash + '@' + nonexistentToken;

            assert.response(
                server,
                request(nonexistentNamedMapToken),
                expectedResponse,
                checkTileFn(done)
            );
        });

        it('returns an error for named map nonexistent tokens without template hash', function (done) {
            var nonexistentNamedMapToken = username + '@' + nonexistentToken;

            assert.response(
                server,
                request(nonexistentNamedMapToken),
                expectedResponse,
                checkTileFn(done)
            );
        });
    });

    var torqueParamsScenarios = [
        {
            templateParams: {},
            expectedTile: [{ x__uint8: 125, y__uint8: 159, vals__uint8: [2], dates__uint16: [0] }]
        },
        {
            templateParams: { namesFilter: "'Hawai'" },
            expectedTile: [{ x__uint8: 125, y__uint8: 159, vals__uint8: [1], dates__uint16: [0] }]
        }
    ];
    torqueParamsScenarios.forEach(function (scenario) {
        it('can instantiate with torque layer and params=' + JSON.stringify(scenario.templateParams), function (done) {
            var torqueParamsTemplate = {
                version: '0.0.1',
                name: 'acceptance_torque_params',
                auth: {
                    method: 'open'
                },
                placeholders: {
                    namesFilter: {
                        type: 'sql_ident',
                        default: "'Hawai', 'El Estocolmo'"
                    }
                },
                layergroup: {
                    version: '1.4.0',
                    layers: [
                        {
                            type: 'torque',
                            options: {
                                sql: 'select * from test_table_private_1 where name in (<%= namesFilter %>)',
                                cartocss: 'Map { -torque-frame-count:1; -torque-resolution:1; ' +
                                "-torque-aggregation-function:'count(*)'; -torque-time-attribute:'cartodb_id'; }",
                                cartocss_version: '2.0.2'
                            }
                        }
                    ]
                }
            };

            var layergroupIdToDelete;
            step(
                function createTemplate () {
                    var next = this;
                    var createTemplateRequest = {
                        url: '/api/v1/map/named?api_key=1234',
                        method: 'POST',
                        headers: {
                            host: 'localhost',
                            'Content-Type': 'application/json'
                        },
                        data: JSON.stringify(torqueParamsTemplate)
                    };
                    assert.response(
                        server,
                        createTemplateRequest,
                        {
                            status: 200
                        },
                        function (res, err) {
                            next(err, res);
                        }
                    );
                },
                function instantiateTemplate (err, res) {
                    assert.ifError(err);
                    var parsed = JSON.parse(res.body);
                    assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'template_id'), "Missing 'template_id' from response: " + res.body);
                    var templateId = parsed.template_id;
                    var instantiatePostRequest = {
                        url: '/api/v1/map/named/' + templateId,
                        method: 'POST',
                        headers: {
                            host: 'localhost',
                            'Content-Type': 'application/json'
                        },
                        data: JSON.stringify(scenario.templateParams)
                    };
                    var next = this;
                    assert.response(
                        server,
                        instantiatePostRequest,
                        {
                            status: 200
                        },
                        function (res, err) {
                            return next(err, res);
                        }
                    );
                },
                function requestTile (err, res) {
                    assert.ifError(err);

                    var layergroupId = JSON.parse(res.body).layergroupid;
                    layergroupIdToDelete = LayergroupToken.parse(layergroupId).token;

                    var torqueTileRequest = {
                        url: '/api/v1/map/' + layergroupId + '/0/0/0/0.torque.json',
                        method: 'GET',
                        headers: {
                            host: 'localhost'
                        }
                    };
                    var next = this;
                    assert.response(
                        server,
                        torqueTileRequest,
                        {
                            status: 200
                        },
                        function (res, err) {
                            return next(err, res);
                        }
                    );
                },
                function validateTileAndFinish (err, res) {
                    if (err) {
                        return done(err);
                    }

                    keysToDelete['map_cfg|' + layergroupIdToDelete] = 0;
                    keysToDelete['map_tpl|localhost'] = 0;
                    keysToDelete['user:localhost:mapviews:global'] = 5;

                    assert.deepStrictEqual(
                        JSON.parse(res.body),
                        scenario.expectedTile
                    );

                    done();
                }
            );
        });
    });
});
