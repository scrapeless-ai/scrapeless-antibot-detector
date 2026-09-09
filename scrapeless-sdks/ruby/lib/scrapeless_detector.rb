# frozen_string_literal: true

# Scrapeless Anti-Bot Detector — Ruby SDK.
#
# Ruby cannot hear the extension directly. The extension talks to the *page*, by
# dispatching CustomEvents at window, so this SDK drives a real Chrome with the
# extension loaded (via playwright-ruby-client) and reads the result back out of
# the document.
#
# Every wait is bounded: the page API ships disabled and the extension may be
# absent, and neither announces itself. A result carrying available:false is
# returned instead of hanging. Check `available` before trusting a false.
module ScrapelessDetector
  ANTIBOT     = 'antibot'
  CAPTCHA     = 'captcha'
  FINGERPRINT = 'fingerprint'
  OTHER       = 'other'

  UNAVAILABLE = 'unavailable'
  DEFAULT_TIMEOUT_MS = 8000

  # The bundled detectors ship four spellings — 'Anti-Bot', 'ANTIBOT',
  # 'CAPTCHA', 'Fingerprint' — so comparing against one matches almost nothing.
  CATEGORY_ALIASES = {
    'antibot' => ANTIBOT,
    'waf' => ANTIBOT,
    'captcha' => CAPTCHA,
    'fingerprint' => FINGERPRINT,
    'fingerprinting' => FINGERPRINT
  }.freeze

  module_function

  # Fold any category spelling to one of the four keys.
  def category_key_of(detection)
    raw = ''
    if detection.is_a?(Hash)
      if !detection['category'].nil?
        raw = detection['category']
      else
        nested = detection['detector']
        raw = nested['category'] if nested.is_a?(Hash) && !nested['category'].nil?
      end
    end
    folded = raw.to_s.strip.downcase.gsub(/[^a-z]/, '')
    CATEGORY_ALIASES.fetch(folded, OTHER)
  end

  def empty_counts
    { ANTIBOT => 0, CAPTCHA => 0, FINGERPRINT => 0, OTHER => 0 }
  end

  # Normalize one detection without discarding what else it carried.
  def normalize_detection(source)
    payload = source.is_a?(Hash) ? source : {}

    name = payload['name']
    if name.nil? || name.to_s.empty?
      nested = payload['detector']
      name = nested.is_a?(Hash) ? nested['name'] : nested
    end
    name = 'Unknown' if name.nil? || name.to_s.empty?

    # A non-numeric confidence becomes nil, never a bogus number.
    confidence = payload['confidence'].is_a?(Numeric) ? payload['confidence'].to_f : nil

    payload.merge(
      'name' => name.to_s,
      'categoryKey' => category_key_of(payload),
      'confidence' => confidence
    )
  end

  # A result you can always read, present or not.
  class Result
    attr_reader :available, :reason, :url, :timestamp, :from_cache,
                :total, :reported_total, :categories, :detections

    def initialize(fields)
      @available      = fields[:available]
      @reason         = fields[:reason]
      @url            = fields[:url]
      @timestamp      = fields[:timestamp]
      @from_cache     = fields[:from_cache]
      @total          = fields[:total]
      @reported_total = fields[:reported_total]
      @categories     = fields[:categories]
      @detections     = fields[:detections]
    end

    def has_category?(key)
      available && categories.fetch(key.to_s.strip.downcase, 0) > 0
    end

    def antibot?     = has_category?(ScrapelessDetector::ANTIBOT)
    def captcha?     = has_category?(ScrapelessDetector::CAPTCHA)
    def fingerprinted? = has_category?(ScrapelessDetector::FINGERPRINT)
    def protected?   = available && total > 0

    def of_category(key)
      wanted = key.to_s.strip.downcase
      detections.select { |d| d['categoryKey'] == wanted }
    end
  end

  def build_result(available, detail, reason = nil)
    payload = detail.is_a?(Hash) ? detail : {}
    raw = payload['detections']
    detections = raw.is_a?(Array) ? raw.map { |d| normalize_detection(d) } : []

    categories = empty_counts
    detections.each { |d| categories[d['categoryKey']] += 1 }

    # detectionCount is the extension's claim; size is what arrived.
    claimed = payload['detectionCount']
    reported = claimed.is_a?(Numeric) ? claimed.to_i : detections.size

    Result.new(
      available: available == true,
      reason: reason,
      url: payload['url'],
      timestamp: payload['timestamp'],
      from_cache: payload['fromCache'] == true,
      total: detections.size,
      reported_total: reported,
      categories: categories,
      detections: detections
    )
  end

  def unavailable(reason = UNAVAILABLE)
    build_result(false, nil, reason)
  end
end
