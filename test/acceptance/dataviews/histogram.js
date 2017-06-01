require('../../support/test_helper');

var assert = require('../../support/assert');
var TestClient = require('../../support/test-client');

function createMapConfig(layers, dataviews, analysis) {
    return {
        version: '1.5.0',
        layers: layers,
        dataviews: dataviews || {},
        analyses: analysis || []
    };
}

describe('histogram-dataview', function() {

    afterEach(function(done) {
        if (this.testClient) {
            this.testClient.drain(done);
        } else {
            done();
        }
    });

    var mapConfig = createMapConfig(
        [
            {
                "type": "cartodb",
                "options": {
                    "source": {
                        "id": "2570e105-7b37-40d2-bdf4-1af889598745"
                    },
                    "cartocss": "#points { marker-width: 10; marker-fill: red; }",
                    "cartocss_version": "2.3.0"
                }
            }
        ],
        {
            pop_max_histogram: {
                source: {
                    id: '2570e105-7b37-40d2-bdf4-1af889598745'
                },
                type: 'histogram',
                options: {
                    column: 'x'
                }
            }
        },
        [
            {
                "id": "2570e105-7b37-40d2-bdf4-1af889598745",
                "type": "source",
                "params": {
                    "query": "select null::geometry the_geom_webmercator, x from generate_series(0,1000) x"
                }
            }
        ]
    );

    it('should get bin_width right when max > min in filter', function(done) {
        var params = {
            bins: 10,
            start: 1e3,
            end: 0
        };

        this.testClient = new TestClient(mapConfig, 1234);
        this.testClient.getDataview('pop_max_histogram', params, function(err, dataview) {
            assert.ok(!err, err);

            assert.equal(dataview.type, 'histogram');
            assert.ok(dataview.bin_width > 0, 'Unexpected bin width: ' + dataview.bin_width);
            dataview.bins.forEach(function(bin) {
                assert.ok(bin.min <= bin.max, 'bin min < bin max: ' + JSON.stringify(bin));
            });

            done();
        });
    });

    it('should cast all overridable params to numbers', function(done) {
        var params = {
            bins: '256 AS other, (select 256 * 2) AS bins_number--',
            start: 1e3,
            end: 0,
            response: TestClient.RESPONSE.ERROR
        };

        this.testClient = new TestClient(mapConfig, 1234);
        this.testClient.getDataview('pop_max_histogram', params, function(err, res) {
            assert.ok(!err, err);

            assert.ok(res.errors);
            assert.equal(res.errors.length, 1);
            assert.ok(res.errors[0].match(/Invalid number format for parameter 'bins'/));

            done();
        });
    });

});

describe('histogram-dataview for date column type', function() {
    afterEach(function(done) {
        if (this.testClient) {
            this.testClient.drain(done);
        } else {
            done();
        }
    });

    var mapConfig = createMapConfig(
        [
            {
                "type": "cartodb",
                "options": {
                    "source": {
                        "id": "date-histogram-source"
                    },
                    "cartocss": "#points { marker-width: 10; marker-fill: red; }",
                    "cartocss_version": "2.3.0"
                }
            }
        ],
        {
            date_histogram: {
                source: {
                    id: 'date-histogram-source'
                },
                type: 'histogram',
                options: {
                    column: 'd',
                    aggregation: 'month'
                }
            }
        },
        [
            {
                "id": "date-histogram-source",
                "type": "source",
                "params": {
                    "query": [
                        "select null::geometry the_geom_webmercator, date AS d",
                        "from generate_series(",
                            "'2007-02-15 01:00:00'::timestamp, '2008-04-09 01:00:00'::timestamp, '1 day'::interval",
                        ") date"
                    ].join(' ')
                }
            }
        ]
    );

    it('should create a date histogram aggregated in months', function (done) {
        this.testClient = new TestClient(mapConfig, 1234);
        this.testClient.getDataview('date_histogram', {}, function(err, dataview) {
            assert.ok(!err, err);
            assert.equal(dataview.type, 'histogram');
            assert.ok(dataview.bin_width > 0, 'Unexpected bin width: ' + dataview.bin_width);
            dataview.bins.forEach(function(bin) {
                assert.ok(bin.min <= bin.max, 'bin min < bin max: ' + JSON.stringify(bin));
            });

            done();
        });
    });

    it('should override aggregation in weeks', function (done) {
        var params = {
            aggregation: 'week'
        };

        this.testClient = new TestClient(mapConfig, 1234);
        this.testClient.getDataview('date_histogram', params, function(err, dataview) {
            assert.ok(!err, err);
            assert.equal(dataview.type, 'histogram');
            assert.ok(dataview.bin_width > 0, 'Unexpected bin width: ' + dataview.bin_width);
            dataview.bins.forEach(function(bin) {
                assert.ok(bin.min <= bin.max, 'bin min < bin max: ' + JSON.stringify(bin));
            });

            done();
        });
    });
});
