import { Hero } from './Hero'
import { Developers, Features, FinalCta, HowItWorks, Security } from './Sections'

export default function LandingPage() {
  return (
    <>
      <Hero />
      <Features />
      <HowItWorks />
      <Security />
      <Developers />
      <FinalCta />
    </>
  )
}
