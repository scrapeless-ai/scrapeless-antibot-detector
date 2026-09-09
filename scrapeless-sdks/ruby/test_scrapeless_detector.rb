# frozen_string_literal: true

# Tests read ../conformance.json, the shared truth for every SDK, so a fold that
# drifts here fails here. Chrome is faked at its one seam (page.evaluate), which
# covers the whole surface with no browser and no display.

require 'minitest/autorun'
require 'json'
require_relative 'lib/scrapeless_detector'
require_relative 'lib/scrapeless_detector/browser'

VECTORS = JSON.parse(File.read(File.join(__dir__, '..', 'conformance.json')))

class FakePage
  attr_reader :init_scripts

  def initialize(detection: nil, ready: nil, installed: true)
    @detection = detection
    @ready = ready
    @installed = installed
    @init_scripts = []
  end

  def add_init_script(script:) = @init_scripts << script

  def evaluate(expression, arg: nil)
    case expression
    when ScrapelessDetector::INSTALLED then @installed
    when ScrapelessDetector::SNAPSHOT then @detection
    when ScrapelessDetector::READY then @ready
    when ScrapelessDetector::AWAIT_DETECTION then @detection
    end
  end
end

class SharedVectors < Minitest::Test
  def test_category_fold_matches_every_shared_vector
    VECTORS['categoryFold'].each do |vector|
      assert_equal vector['expect'],
                   ScrapelessDetector.category_key_of({ 'category' => vector['raw'] }),
                   "#{vector['raw'].inspect} should fold to #{vector['expect']}"
    end
  end

  def test_result_shape_matches_every_shared_vector
    VECTORS['results'].each do |vector|
      result = ScrapelessDetector.build_result(true, vector['detail'])
      want = vector['expect']
      assert_equal want['available'],     result.available,      "#{vector['name']}: available"
      assert_equal want['total'],         result.total,          "#{vector['name']}: total"
      assert_equal want['reportedTotal'], result.reported_total, "#{vector['name']}: reportedTotal"
      assert_equal want['categories'],    result.categories,     "#{vector['name']}: categories"
      assert_equal want['isAntibot'],     result.antibot?,       "#{vector['name']}: isAntibot"
      assert_equal want['isProtected'],   result.protected?,     "#{vector['name']}: isProtected"
      if want['firstName']
        assert_equal want['firstName'], result.detections[0]['name']
        assert_equal want['firstCategoryKey'], result.detections[0]['categoryKey']
      end
      if want['lastConfidenceIsNull']
        assert_nil result.detections.last['confidence'],
                   'a non-numeric confidence must be nil, not a bogus number'
      end
    end
  end

  def test_unavailable_matches_the_shared_vector
    result = ScrapelessDetector.unavailable
    want = VECTORS['unavailable']['expect']
    assert_equal want['available'], result.available
    assert_equal want['reason'],    result.reason
    assert_equal want['total'],     result.total
    # false here must never be read as "clean" — available says which it is.
    assert_equal want['isAntibot'],   result.antibot?
    assert_equal want['isProtected'], result.protected?
  end

  def test_embedded_bridge_matches_canonical
    canonical = File.read(File.join(__dir__, '..', 'bridge.js')).strip
    assert_equal canonical, ScrapelessDetector::INIT_SCRIPT.strip,
                 'lib/scrapeless_detector/browser.rb has drifted from scrapeless-sdks/bridge.js'
  end
end

class BrowserSurface < Minitest::Test
  def sample = VECTORS['results'][0]['detail']

  def test_attach_installs_the_listener_at_document_start
    page = FakePage.new(detection: sample)
    ScrapelessDetector::Detector.attach(page)
    assert_equal 1, page.init_scripts.size
    assert_includes page.init_scripts[0], '__scrapelessSdkBridge'
  end

  def test_detect_answers_and_helpers_agree
    detector = ScrapelessDetector::Detector.attach(FakePage.new(detection: sample))
    assert detector.detect.available
    assert detector.antibot?
    assert detector.captcha?
    assert detector.fingerprinted?
    assert detector.protected?
  end

  def test_no_extension_is_unavailable_not_a_hang
    detector = ScrapelessDetector::Detector.attach(FakePage.new(installed: false))
    result = detector.detect
    refute result.available
    assert_equal 'unavailable', result.reason
    refute detector.antibot?
    assert_nil detector.snapshot
    assert_equal({ 'available' => false, 'version' => nil }, detector.ready)
  end

  def test_bridge_installed_but_nothing_arrives
    # Page signals off: the bounded wait expires.
    refute ScrapelessDetector::Detector.attach(FakePage.new(detection: nil)).detect.available
  end

  def test_ready_reports_the_announcement
    detector = ScrapelessDetector::Detector.attach(
      FakePage.new(detection: sample, ready: { 'version' => '1.0.1' })
    )
    assert_equal({ 'available' => true, 'version' => '1.0.1' }, detector.ready)
  end

  def test_of_category_filters
    result = ScrapelessDetector.build_result(true, sample)
    assert_equal ['Cloudflare Bot Management'],
                 result.of_category('antibot').map { |d| d['name'] }
  end

  def test_original_fields_survive
    result = ScrapelessDetector.build_result(
      true, { 'detections' => [{ 'name' => 'Akamai', 'vendorNote' => 'keep me' }] }
    )
    assert_equal 'keep me', result.detections[0]['vendorNote']
  end
end
