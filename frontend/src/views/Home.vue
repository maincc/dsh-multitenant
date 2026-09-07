<template>
  <div class="home">
    <div class="hero">
      <h1>{{ $t('home.heroTitle') }}</h1>
      <p class="subtitle">{{ $t('home.subtitle') }}</p>

      <div class="features">
        <div class="feature-card">
          <div class="icon">🔐</div>
          <h3>{{ $t('home.features.wallet.title') }}</h3>
          <p>{{ $t('home.features.wallet.desc') }}</p>
        </div>
        <div class="feature-card">
          <div class="icon">📦</div>
          <h3>{{ $t('home.features.container.title') }}</h3>
          <p>{{ $t('home.features.container.desc') }}</p>
        </div>
        <div class="feature-card">
          <div class="icon">⚡</div>
          <h3>{{ $t('home.features.scale.title') }}</h3>
          <p>{{ $t('home.features.scale.desc') }}</p>
        </div>
        <div class="feature-card">
          <div class="icon">💾</div>
          <h3>{{ $t('home.features.persist.title') }}</h3>
          <p>{{ $t('home.features.persist.desc') }}</p>
        </div>
      </div>

      <div class="actions">
        <router-link to="/user" class="btn btn-primary btn-large">
          {{ $t('home.actions.start') }}
        </router-link>
        <router-link to="/admin" class="btn btn-success btn-large">
          {{ $t('home.actions.admin') }}
        </router-link>
      </div>
    </div>

    <div class="guide">
      <h2>{{ $t('home.guide.title') }}</h2>

      <div class="guide-steps">
        <div class="guide-step">
          <div class="step-num">1</div>
          <div class="step-body">
            <h3>{{ $t('home.guide.step1.title') }}</h3>
            <p>
              {{ $t('home.guide.step1.body') }}
              <a
                href="https://chromewebstore.google.com/detail/ccdao-connector/fpondiojcgaollhcmjgpjmldjjkealjb"
                target="_blank"
                rel="noopener noreferrer"
                >{{ $t('home.guide.step1.linkLabel') }}</a
              >{{ $t('home.guide.step1.tail') }}
            </p>
          </div>
        </div>
        <div class="guide-step">
          <div class="step-num">2</div>
          <div class="step-body">
            <h3>{{ $t('home.guide.step2.title') }}</h3>
            <p>
              {{ $t('home.guide.step2.body') }}
              {{ $t('home.guide.step2.sig', { sign: $t('home.guide.step2.signLabel') }) }}
            </p>
          </div>
        </div>
        <div class="guide-step">
          <div class="step-num">3</div>
          <div class="step-body">
            <h3>{{ $t('home.guide.step3.title') }}</h3>
            <p>
              {{
                $t('home.guide.step3.body', {
                  min: $t('home.guide.step3.minLabel'),
                  cwt: $t('home.guide.step3.cwtLabel'),
                  exempt: $t('home.guide.step3.exemptLabel'),
                })
              }}
            </p>
          </div>
        </div>
        <div class="guide-step">
          <div class="step-num">4</div>
          <div class="step-body">
            <h3>{{ $t('home.guide.step4.title') }}</h3>
            <p>
              {{ $t('home.guide.step4.body', { admin: $t('home.guide.step4.adminLabel') }) }}
            </p>
          </div>
        </div>
        <div class="guide-step">
          <div class="step-num">5</div>
          <div class="step-body">
            <h3>{{ $t('home.guide.step5.title') }}</h3>
            <p>
              {{
                $t('home.guide.step5.body', {
                  install: $t('home.guide.step5.installLabel'),
                  noAuto: $t('home.guide.step5.noAutoLabel'),
                })
              }}
            </p>
          </div>
        </div>
        <div class="guide-step">
          <div class="step-num">6</div>
          <div class="step-body">
            <h3>{{ $t('home.guide.step6.title') }}</h3>
            <p>
              {{ $t('home.guide.step6.body', { sign: $t('home.guide.step6.signLabel') }) }}
            </p>
          </div>
        </div>
      </div>

      <div class="guide-notes">
        <h3>{{ $t('home.guide.notes.title') }}</h3>
        <ul>
          <li>{{ $t('home.guide.notes.item1', { data: $t('home.guide.notes.dataLabel') }) }}</li>
          <li>
            {{ $t('home.guide.notes.item2', { before: $t('home.guide.notes.beforeLabel') }) }}
          </li>
          <li>{{ $t('home.guide.notes.item3') }}</li>
        </ul>
      </div>
    </div>

    <div class="tiers">
      <h2>{{ $t('home.tiers.title') }}</h2>
      <div class="tier-grid">
        <div class="tier-card">
          <h3>{{ $t('home.tiers.t1.name') }}</h3>
          <ul>
            <li>{{ $t('home.tiers.t1.memory') }}</li>
            <li>{{ $t('home.tiers.t1.cpu') }}</li>
            <li>{{ $t('home.tiers.t1.pids') }}</li>
            <li>{{ $t('home.tiers.t1.use') }}</li>
          </ul>
        </div>
        <div class="tier-card featured">
          <h3>{{ $t('home.tiers.t2.name') }}</h3>
          <ul>
            <li>{{ $t('home.tiers.t2.memory') }}</li>
            <li>{{ $t('home.tiers.t2.cpu') }}</li>
            <li>{{ $t('home.tiers.t2.pids') }}</li>
            <li>{{ $t('home.tiers.t2.use') }}</li>
          </ul>
          <span class="badge badge-info">{{ $t('home.tiers.t2.badge') }}</span>
        </div>
        <div class="tier-card">
          <h3>{{ $t('home.tiers.t3.name') }}</h3>
          <ul>
            <li>{{ $t('home.tiers.t3.memory') }}</li>
            <li>{{ $t('home.tiers.t3.cpu') }}</li>
            <li>{{ $t('home.tiers.t3.pids') }}</li>
            <li>{{ $t('home.tiers.t3.use') }}</li>
          </ul>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup></script>

<style scoped>
.hero {
  text-align: center;
  padding: 3rem 1rem;
  background: white;
  border-radius: 16px;
  margin-bottom: 2rem;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.08);
}

.hero h1 {
  font-size: 2.5rem;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  margin-bottom: 0.5rem;
}

.subtitle {
  font-size: 1.2rem;
  color: #6b7280;
  margin-bottom: 2rem;
}

.features {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 1.5rem;
  margin: 2rem 0;
  text-align: left;
}

.feature-card {
  padding: 1.5rem;
  background: #f9fafb;
  border-radius: 12px;
  transition: transform 0.3s;
}

.feature-card:hover {
  transform: translateY(-4px);
}

.feature-card .icon {
  font-size: 2rem;
  margin-bottom: 0.5rem;
}

.feature-card h3 {
  font-size: 1.1rem;
  margin-bottom: 0.5rem;
  color: #374151;
}

.feature-card p {
  font-size: 0.9rem;
  color: #6b7280;
}

.actions {
  display: flex;
  gap: 1rem;
  justify-content: center;
  margin-top: 2rem;
}

.btn-large {
  padding: 0.75rem 2rem;
  font-size: 1rem;
}

.guide {
  background: white;
  padding: 2rem;
  border-radius: 16px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.08);
  margin-bottom: 2rem;
}

.guide h2 {
  text-align: center;
  margin-bottom: 2rem;
  color: #667eea;
}

.guide-steps {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 1.25rem;
  margin-bottom: 2rem;
}

.guide-step {
  display: flex;
  gap: 1rem;
  padding: 1.25rem;
  background: #f9fafb;
  border-radius: 12px;
  border: 1px solid #eef0f3;
}

.step-num {
  flex-shrink: 0;
  width: 2rem;
  height: 2rem;
  border-radius: 50%;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
}

.step-body h3 {
  margin: 0 0 0.35rem;
  font-size: 1rem;
  color: #374151;
}

.step-body p {
  margin: 0;
  font-size: 0.88rem;
  color: #6b7280;
  line-height: 1.55;
}

.step-body a {
  color: #667eea;
}

.guide-notes {
  padding: 1.25rem 1.5rem;
  background: #fff8e6;
  border-radius: 12px;
  border: 1px solid #f5e3b3;
}

.guide-notes h3 {
  margin: 0 0 0.75rem;
  font-size: 0.95rem;
  color: #8a6d1a;
}

.guide-notes ul {
  margin: 0;
  padding-left: 1.25rem;
}

.guide-notes li {
  font-size: 0.88rem;
  color: #6b5b1e;
  line-height: 1.8;
}

.tiers {
  background: white;
  padding: 2rem;
  border-radius: 16px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.08);
}

.tiers h2 {
  text-align: center;
  margin-bottom: 2rem;
  color: #667eea;
}

.tier-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
  gap: 1.5rem;
}

.tier-card {
  padding: 1.5rem;
  background: #f9fafb;
  border-radius: 12px;
  border: 2px solid transparent;
  position: relative;
}

.tier-card.featured {
  border-color: #667eea;
  background: linear-gradient(135deg, #f0f4ff 0%, #faf5ff 100%);
}

.tier-card h3 {
  margin-bottom: 1rem;
  color: #374151;
}

.tier-card ul {
  list-style: none;
  margin-bottom: 1rem;
}

.tier-card li {
  padding: 0.5rem 0;
  border-bottom: 1px solid #e5e7eb;
  font-size: 0.9rem;
}

.tier-card li:last-child {
  border-bottom: none;
}
</style>
