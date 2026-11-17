import { NormalizedTrend, VerifiedFact, ScriptPackage, SEOPackage, QualityControlReport } from '../types';

export const INITIAL_TRENDS: NormalizedTrend[] = [
  {
    id: 'trend-rm-fcb-01',
    country: 'US',
    language: 'en',
    keyword: 'Real Madrid vs Barcelona',
    rank: 1,
    trend_score: 94,
    velocity: 91,
    search_volume: 88,
    detected_at: '2026-09-06T12:00:00Z',
    category: 'sports',
    description: 'El Clásico sparked a sudden 400% query surge following a 94th-minute overturned VAR goal and an unexpected red card that sealed the league lead.',
    image_url: '',
    detectedIntent: 'why_trending',
    primaryQuestion: 'Why is Real Madrid vs Barcelona trending today?',
    candidateQuestions: [
      'Why is Real Madrid vs Barcelona trending today?',
      'What happened in Real Madrid vs Barcelona?',
      'Who won Real Madrid vs Barcelona?',
      'Why are people searching for Real Madrid vs Barcelona?',
      'What changed today?'
    ],
    sources: [
      {
        name: 'The Athletic / NYT Sports',
        title: 'El Clásico Drama: Stoppage Time VAR Drama Decides Top of the Table',
        url: 'https://theathletic.com/football/el-clasico-analysis',
        publishedAt: '2026-09-06T11:42:00Z',
        snippet: 'A controversial 94th-minute offside millimeter review ruled out an equalizer after Barcelona thought they had leveled the game.',
        credibilityScore: 98
      },
      {
        name: 'ESPN FC',
        title: 'Real Madrid edge Barcelona 2-1 in fiery Bernabéu encounter',
        url: 'https://espn.com/soccer/report-elclasico',
        publishedAt: '2026-09-06T11:15:00Z',
        snippet: 'Goals from Vinicius Jr and Bellingham before late controversy sparked global social outrage.',
        credibilityScore: 95
      },
      {
        name: 'La Liga Official Match Center',
        title: 'Match Summary: Matchday 28 Real Madrid 2 - 1 FC Barcelona',
        url: 'https://laliga.com/match/elclasico',
        publishedAt: '2026-09-06T11:05:00Z',
        snippet: 'Official referee report confirms VAR intervention for millimeter offside in minute 90+4.',
        credibilityScore: 99
      }
    ]
  },
  {
    id: 'trend-starship-02',
    country: 'US',
    language: 'en',
    keyword: 'Starship Flight 7 Booster Catch',
    rank: 2,
    trend_score: 91,
    velocity: 87,
    search_volume: 85,
    detected_at: '2026-09-06T10:30:00Z',
    category: 'science',
    description: 'SpaceX completed its second consecutive Super Heavy booster catch with the Mechazilla chopstick arms in daylight.',
    detectedIntent: 'what_happened',
    primaryQuestion: 'What happened with SpaceX Starship Flight 7 today?',
    candidateQuestions: [
      'What happened with SpaceX Starship Flight 7 today?',
      'Did SpaceX catch the booster again?',
      'Why is Starship Flight 7 trending?',
      'How does the Mechazilla catch work?'
    ],
    image_url: '',
    sources: [
      {
        name: 'Ars Technica',
        title: 'SpaceX Nails Second Booster Catch at Starbase with Precision',
        url: 'https://arstechnica.com/space/starship-flight-7-catch',
        publishedAt: '2026-09-06T09:50:00Z',
        snippet: 'The 232-foot rocket booster returned to the launch mount exactly 6 minutes and 54 seconds after liftoff.',
        credibilityScore: 97
      },
      {
        name: 'NASA Spaceflight',
        title: 'Live Coverage: Starship Flight 7 achieves key orbital relight test',
        url: 'https://nasaspaceflight.com/starship-flight-7',
        publishedAt: '2026-09-06T09:30:00Z',
        snippet: 'All 33 Raptor engines fired cleanly on descent with thermal protection tiles remaining intact.',
        credibilityScore: 96
      }
    ]
  },
  {
    id: 'trend-nvidia-blackwell-03',
    country: 'US',
    language: 'en',
    keyword: 'Nvidia Quantum AI Architecture',
    rank: 3,
    trend_score: 87,
    velocity: 82,
    search_volume: 79,
    detected_at: '2026-09-06T08:15:00Z',
    category: 'technology',
    description: 'Nvidia announced a hybrid quantum-accelerator rack that reduces transformer training power consumption by 65%.',
    detectedIntent: 'why_important',
    primaryQuestion: 'Why is Nvidia trending today after the hardware keynote?',
    candidateQuestions: [
      'Why is Nvidia trending today after the hardware keynote?',
      'What is Nvidia Quantum AI?',
      'How does the new GPU cut power by 65%?',
      'Is Nvidia releasing new consumer chips?'
    ],
    image_url: '',
    sources: [
      {
        name: 'AnandTech / Reuters',
        title: 'Nvidia unveils hybrid quantum accelerator architecture at GTC',
        url: 'https://reuters.com/technology/nvidia-hybrid-quantum-gtc',
        publishedAt: '2026-09-06T07:45:00Z',
        snippet: 'Jensen Huang unveiled liquid-cooled nodes delivering 40 petaflops at one-third prior energy draw.',
        credibilityScore: 94
      }
    ]
  },
  {
    id: 'trend-jwst-exoplanet-04',
    country: 'US',
    language: 'en',
    keyword: 'James Webb Bio-Signatures K2-18b',
    rank: 4,
    trend_score: 84,
    velocity: 78,
    search_volume: 74,
    detected_at: '2026-09-06T06:40:00Z',
    category: 'science',
    description: 'Astrophysicists confirmed 4.8-sigma confidence detection of dimethyl sulfide in the habitable zone exoplanet atmosphere.',
    detectedIntent: 'what_changed',
    primaryQuestion: 'Did James Webb just find signs of alien life on K2-18b?',
    candidateQuestions: [
      'Did James Webb just find signs of alien life on K2-18b?',
      'Why is James Webb telescope trending today?',
      'What is dimethyl sulfide and why does it matter?',
      'What did scientists confirm today?'
    ],
    image_url: '',
    sources: [
      {
        name: 'Nature Astronomy',
        title: 'Spectroscopic confirmation of carbon-bearing molecules on K2-18b',
        url: 'https://nature.com/articles/s41550-026-jwst',
        publishedAt: '2026-09-06T06:00:00Z',
        snippet: 'Data from JWST NIRISS and NIRSpec provides the most robust evidence yet of oceanic vapor chemistry.',
        credibilityScore: 99
      }
    ]
  }
];

export const PRESET_FACTS_MAP: Record<string, VerifiedFact[]> = {
  'trend-rm-fcb-01': [
    {
      id: 'fact-1',
      claim: 'Real Madrid defeated Barcelona 2-1 at the Santiago Bernabéu.',
      sourceName: 'La Liga Official Match Center',
      sourceUrl: 'https://laliga.com/match/elclasico',
      confidence: 100,
      corroboratedByCount: 4,
      status: 'verified'
    },
    {
      id: 'fact-2',
      claim: 'In minute 90+4, Barcelona scored an apparent equalizer that was overturned by semi-automated offside technology.',
      sourceName: 'The Athletic / NYT Sports',
      sourceUrl: 'https://theathletic.com/football/el-clasico-analysis',
      confidence: 99,
      corroboratedByCount: 3,
      status: 'verified'
    },
    {
      id: 'fact-3',
      claim: 'The margin of the offside call was measured at 1.8 centimeters from the boot heel.',
      sourceName: 'ESPN FC Technology Analysis',
      sourceUrl: 'https://espn.com/soccer/report-elclasico',
      confidence: 95,
      corroboratedByCount: 2,
      status: 'verified'
    },
    {
      id: 'fact-4',
      claim: 'The victory puts Real Madrid 5 points clear at the summit of the league table.',
      sourceName: 'Reuters Sports',
      sourceUrl: 'https://reuters.com/sports/soccer',
      confidence: 100,
      corroboratedByCount: 4,
      status: 'verified'
    }
  ]
};

export const PRESET_SCRIPT_MAP: Record<string, ScriptPackage> = {
  'trend-rm-fcb-01': {
    id: 'script-rm-fcb-01',
    trendKeyword: 'Real Madrid vs Barcelona',
    headlineQuestion: 'Why is Real Madrid vs Barcelona trending today?',
    searchIntent: 'why_trending',
    angle: {
      id: 'angle-1',
      angleType: 'the_sudden_twist',
      title: 'The 1.8-Centimeter Heartbreak',
      hookPremise: 'It wasn’t just a 2-1 scoreline—it was a 94th-minute VAR heartbreak that tore the football world in half.',
      editorialTone: 'urgent_explainer',
      whyThisWorks: 'Directly answers the user search question immediately in the first 3 seconds, then shows the undeniable verified evidence.'
    },
    fullScript:
      'Why is Real Madrid vs Barcelona trending right now? If you checked the score and saw 2-1, you missed the real drama. In the 94th minute of stoppage time, Barcelona thought they snatched an equalizer. But semi-automated VAR stepped in—ruling offside by just 1.8 centimeters. Real Madrid holds the 5-point title lead, and fans are furious.',
    estimatedDurationSec: 38,
    wordCount: 65,
    targetAudience: 'Global football fans & casual sports searchers wanting instant factual clarity',
    scenes: [
      {
        id: 'scene-1',
        sceneNumber: 1,
        timestampStart: 0,
        timestampEnd: 4,
        narratorText: 'Why is Real Madrid vs Barcelona trending right now?',
        visualPrompt: 'Dramatic split-screen of Bernabéu stadium under night lights with glowing search query overlay',
        shotType: 'headline_pop',
        graphicOverlay: 'WHY IS EL CLÁSICO TRENDING TODAY?',
        assetUrl: '',
        audioEmphasisWords: ['trending', 'right now']
      },
      {
        id: 'scene-2',
        sceneNumber: 2,
        timestampStart: 4,
        timestampEnd: 11,
        narratorText: 'If you checked the score and saw 2-1, you missed what actually ignited the internet.',
        visualPrompt: 'Scoreboard graphic pulsing 2-1 with dynamic red warning highlight and referee whistle sound',
        shotType: 'kinetic_split',
        graphicOverlay: 'NOT JUST A 2-1 SCORELINE',
        assetUrl: '',
        audioEmphasisWords: ['missed', 'actually ignited']
      },
      {
        id: 'scene-3',
        sceneNumber: 3,
        timestampStart: 11,
        timestampEnd: 22,
        narratorText: 'In the 94th minute, Barcelona erupted after slotting home an equalizer. But VAR stepped in.',
        visualPrompt: 'High-tech 3D calibrated pitch projection highlighting player boot millimeter line',
        shotType: 'photo_evidence',
        graphicOverlay: 'MIN 90+4: THE OVERTURNED EQUALIZER',
        assetUrl: '',
        audioEmphasisWords: ['94th minute', 'VAR stepped in']
      },
      {
        id: 'scene-4',
        sceneNumber: 4,
        timestampStart: 22,
        timestampEnd: 31,
        narratorText: 'The official margin? Just 1.8 centimeters offside. A single boot heel difference.',
        visualPrompt: 'Macro zoom on millimeter calibrated tracking lines with digital verification badge',
        shotType: 'infographic_stat',
        graphicOverlay: 'VERIFIED MARGIN: 1.8 CM',
        assetUrl: '',
        audioEmphasisWords: ['1.8 centimeters', 'boot heel']
      },
      {
        id: 'scene-5',
        sceneNumber: 5,
        timestampStart: 31,
        timestampEnd: 38,
        narratorText: 'Real Madrid walks away 5 points clear at the top of the table. Was it the right call?',
        visualPrompt: 'Celebration vs despair contrast shot, leading into comment poll prompt',
        shotType: 'dramatic_close',
        graphicOverlay: '5 POINTS CLEAR | DID VAR GET IT RIGHT?',
        assetUrl: '',
        audioEmphasisWords: ['5 points clear', 'right call']
      }
    ]
  }
};

export const PRESET_QC_MAP: Record<string, QualityControlReport> = {
  'trend-rm-fcb-01': {
    overallScore: 98,
    passed: true,
    factTraceabilityScore: 100,
    intentRelevanceScore: 97,
    pacingScore: 96,
    safetyStatus: 'green',
    auditedAt: '2026-09-06T12:02:15Z',
    checks: [
      {
        id: 'qc-1',
        name: 'Intent-Question Alignment',
        category: 'intent',
        status: 'pass',
        score: 98,
        detail: 'Video hook immediately states "Why is Real Madrid vs Barcelona trending right now?" answering exact user query.'
      },
      {
        id: 'qc-2',
        name: 'Source Traceability',
        category: 'accuracy',
        status: 'pass',
        score: 100,
        detail: 'All 4 numerical claims (2-1 score, 94th minute, 1.8 cm, 5-point lead) trace to La Liga and Athletic verified reports.'
      },
      {
        id: 'qc-3',
        name: 'Shorts Pacing & Word Velocity',
        category: 'pacing',
        status: 'pass',
        score: 96,
        detail: '65 words across 38 seconds = 1.7 words/sec (optimal for TikTok/Shorts comprehension).'
      },
      {
        id: 'qc-4',
        name: 'Content Safety & Copyright',
        category: 'compliance',
        status: 'pass',
        score: 100,
        detail: 'Editorial fair-use commentary with verified public facts; no restricted broadcast watermarks.'
      },
      {
        id: 'qc-5',
        name: 'Vertical 9:16 Aspect Composition',
        category: 'production',
        status: 'pass',
        score: 97,
        detail: 'High-contrast headline overlays positioned above UI safe zone (between Y: 15% and Y: 75%).'
      }
    ]
  }
};

export const PRESET_SEO_MAP: Record<string, SEOPackage> = {
  'trend-rm-fcb-01': {
    title: 'Why Real Madrid vs Barcelona is Trending Right Now ⚽ Controversy Explained',
    description:
      'Wondering why El Clásico is blowing up your feed today? Here is the verified 1.8cm millimeter VAR call that decided the 94th minute finish between Real Madrid and Barcelona.\n\nSources verified:\n- La Liga Official Match Center\n- The Athletic Soccer\n- ESPN FC Tracking\n\n#ElClasico #RealMadrid #Barcelona #Shorts #FootballNews',
    hashtags: ['#ElClasico', '#RealMadrid', '#Barcelona', '#VAR', '#Football', '#Shorts'],
    tags: [
      'why is real madrid vs barcelona trending',
      'real madrid barcelona var offside',
      'el clasico highlights today',
      'what happened in real madrid game',
      'bellingham real madrid goal'
    ],
    pinnedComment: 'Was this 1.8 cm offside call correct, or has VAR gone too far? Drop your take below 👇',
    thumbnailHook: 'WHY IT’S TRENDING: THE 1.8 CM CONTROVERSY',
    soundtrackRecommendation: 'Cinematic Tension Beat (128 BPM, Bass Drop at 0:11)'
  }
};
